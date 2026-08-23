const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();

function sanitizeUser(user) {
    // Ne jamais renvoyer le hash du mot de passe au client.
    return {
        id: user.id,
        username: user.username,
        isAdmin: !!user.is_admin,
        isOwner: !!user.is_owner,
        balance: user.balance
    };
}

router.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password || username.trim().length < 2 || password.length < 4) {
            return res.status(400).json({ error: 'Pseudo (2+ caractères) et mot de passe (4+ caractères) requis.' });
        }
        const cleanUsername = username.trim();

        const existing = await db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername);
        if (existing) {
            return res.status(409).json({ error: 'Ce pseudo est déjà pris.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const info = await db.prepare(
            'INSERT INTO users (username, password_hash, is_admin, balance, created_at) VALUES (?, ?, 0, 1000, ?)'
        ).run(cleanUsername, passwordHash, Date.now());

        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
        req.session.userId = user.id;
        res.json({ user: sanitizeUser(user) });
    } catch (err) {
        console.error('Erreur /register :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body || {};
        if (!username || !password) {
            return res.status(400).json({ error: 'Pseudo et mot de passe requis.' });
        }

        const user = await db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
        if (!user) {
            return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' });
        }

        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Pseudo ou mot de passe incorrect.' });
        }

        req.session.userId = user.id;
        res.json({ user: sanitizeUser(user) });
    } catch (err) {
        console.error('Erreur /login :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

// Renvoie l'utilisateur connecté (utilisé au chargement de la page pour
// restaurer la session, sans jamais exposer le mot de passe hashé).
router.get('/me', async (req, res) => {
    try {
        if (!req.session.userId) return res.json({ user: null });
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
        if (!user) return res.json({ user: null });
        res.json({ user: sanitizeUser(user) });
    } catch (err) {
        console.error('Erreur /me :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// ------------------------------------------------------------
// CODE ADMIN PARTAGÉ
// ------------------------------------------------------------
const failedAttempts = new Map(); // IP -> { count, resetAt }
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip) {
    const entry = failedAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) { failedAttempts.delete(ip); return false; }
    return entry.count >= MAX_ATTEMPTS;
}

function recordFailedAttempt(ip) {
    const entry = failedAttempts.get(ip) || { count: 0, resetAt: Date.now() + WINDOW_MS };
    entry.count++;
    failedAttempts.set(ip, entry);
}

router.post('/redeem-admin-code', requireAuth, async (req, res) => {
    try {
        const ip = req.ip;
        if (isRateLimited(ip)) {
            return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
        }

        const { code } = req.body || {};
        const expected = process.env.ADMIN_CODE;

        if (!expected) {
            return res.status(500).json({ error: "Le code admin n'est pas configuré sur ce serveur." });
        }

        if (!code || code.trim().toUpperCase() !== expected.trim().toUpperCase()) {
            recordFailedAttempt(ip);
            return res.status(401).json({ error: 'Code invalide.' });
        }

        await db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(req.user.id);
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
        res.json({ user: sanitizeUser(user) });
    } catch (err) {
        console.error('Erreur /redeem-admin-code :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

module.exports = router;
