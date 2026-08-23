const express = require('express');
const db = require('../db');
const { requireOwner } = require('../middleware');

const router = express.Router();

// Liste de tous les comptes créés sur le site (jamais le mot de passe hashé).
router.get('/users', requireOwner, async (req, res) => {
    try {
        const users = await db.prepare(`
            SELECT id, username, is_admin, is_owner, balance, created_at
            FROM users
            ORDER BY created_at DESC
        `).all();

        res.json({
            users: users.map(u => ({
                id: u.id,
                username: u.username,
                isAdmin: !!u.is_admin,
                isOwner: !!u.is_owner,
                balance: u.balance,
                createdAt: u.created_at
            }))
        });
    } catch (err) {
        console.error('Erreur GET /admin/users :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Tous les paris de tous les utilisateurs (les plus récents d'abord), avec
// le pseudo du parieur, pour pouvoir repérer un usage abusif.
router.get('/bets', requireOwner, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
        const rows = await db.prepare(`
            SELECT bets.*, users.username, markets.title AS market_title, markets.market_type, options.name AS option_name
            FROM bets
            JOIN users ON users.id = bets.user_id
            JOIN markets ON markets.id = bets.market_id
            JOIN options ON options.id = bets.option_id
            ORDER BY bets.created_at DESC
            LIMIT ?
        `).all(limit);

        res.json({
            bets: rows.map(b => ({
                id: b.id,
                username: b.username,
                marketId: b.market_id,
                marketTitle: b.market_title,
                option: b.market_type === 'binary' ? (b.direction === 'YES' ? 'Oui' : 'Non') : b.option_name,
                direction: b.direction,
                amount: b.amount,
                payout: b.payout,
                status: b.status,
                timestamp: b.created_at
            }))
        });
    } catch (err) {
        console.error('Erreur GET /admin/bets :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Petit résumé chiffré pour un coup d'œil rapide (nombre de comptes, de
// paris, montant total misé en circulation...).
// NB : COUNT(*) renvoie un bigint que le driver Postgres retourne sous
// forme de string -> on force Number() pour éviter les surprises côté client.
router.get('/stats', requireOwner, async (req, res) => {
    try {
        const userCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c);
        const adminCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get()).c);
        const marketCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM markets').get()).c);
        const betCount = Number((await db.prepare('SELECT COUNT(*) AS c FROM bets').get()).c);
        const totalStaked = Number((await db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM bets').get()).s);
        const totalBalance = Number((await db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM users').get()).s);

        res.json({ userCount, adminCount, marketCount, betCount, totalStaked, totalBalance });
    } catch (err) {
        console.error('Erreur GET /admin/stats :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Bannit un compte : supprime le compte (et ses données) définitivement.
router.delete('/users/:id', requireOwner, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        if (targetId === req.user.id) {
            return res.status(400).json({ error: 'Impossible de vous bannir vous-même.' });
        }

        const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
        if (!target) return res.status(404).json({ error: 'Compte introuvable.' });

        const pendingBets = await db.prepare(`SELECT * FROM bets WHERE user_id = ? AND status = 'pending'`).all(targetId);
        for (const bet of pendingBets) {
            // NB : MAX(a, b) n'existe pas en PostgreSQL (seulement en agrégat) ;
            // on calcule donc le plafond à 0 côté JS plutôt qu'en SQL.
            const option = await db.prepare('SELECT * FROM options WHERE id = ?').get(bet.option_id);
            if (!option) continue;
            if (bet.direction === 'YES') {
                const newYes = Math.max(0, option.real_yes - bet.amount);
                await db.prepare('UPDATE options SET real_yes = ? WHERE id = ?').run(newYes, bet.option_id);
            } else {
                const newNo = Math.max(0, option.real_no - bet.amount);
                await db.prepare('UPDATE options SET real_no = ? WHERE id = ?').run(newNo, bet.option_id);
            }
        }

        await db.prepare('DELETE FROM bets WHERE user_id = ?').run(targetId);
        await db.prepare('DELETE FROM group_members WHERE user_id = ?').run(targetId);
        await db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

        res.json({ ok: true });
    } catch (err) {
        console.error('Erreur DELETE /admin/users/:id :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Crédite (ou débite, avec un montant négatif) le solde d'un compte.
router.post('/users/:id/credit', requireOwner, async (req, res) => {
    try {
        const targetId = parseInt(req.params.id);
        const amount = Number(req.body && req.body.amount);
        if (!amount || isNaN(amount)) {
            return res.status(400).json({ error: 'Montant invalide.' });
        }

        const target = await db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
        if (!target) return res.status(404).json({ error: 'Compte introuvable.' });

        const newBalance = Math.max(0, Math.round((target.balance + amount) * 100) / 100);
        await db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, targetId);

        res.json({ ok: true, newBalance });
    } catch (err) {
        console.error('Erreur POST /admin/users/:id/credit :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

module.exports = router;
