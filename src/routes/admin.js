const express = require('express');
const db = require('../db');
const { requireOwner } = require('../middleware');

const router = express.Router();

// Liste de tous les comptes créés sur le site (jamais le mot de passe hashé).
router.get('/users', requireOwner, (req, res) => {
    const users = db.prepare(`
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
});

// Tous les paris de tous les utilisateurs (les plus récents d'abord), avec
// le pseudo du parieur, pour pouvoir repérer un usage abusif.
router.get('/bets', requireOwner, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 300, 1000);
    const rows = db.prepare(`
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
});

// Petit résumé chiffré pour un coup d'œil rapide (nombre de comptes, de
// paris, montant total misé en circulation...).
router.get('/stats', requireOwner, (req, res) => {
    const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
    const marketCount = db.prepare('SELECT COUNT(*) AS c FROM markets').get().c;
    const betCount = db.prepare('SELECT COUNT(*) AS c FROM bets').get().c;
    const totalStaked = db.prepare('SELECT COALESCE(SUM(amount), 0) AS s FROM bets').get().s;
    const totalBalance = db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM users').get().s;

    res.json({ userCount, adminCount, marketCount, betCount, totalStaked, totalBalance });
});

// Bannit un compte : supprime le compte (et ses données) définitivement.
// Les paris en attente sont d'abord retirés des cagnottes (comme une
// annulation) pour ne pas laisser un prix faussé par un compte qui n'existe
// plus, puis tous ses paris et son compte sont supprimés.
router.delete('/users/:id', requireOwner, (req, res) => {
    const targetId = parseInt(req.params.id);
    if (targetId === req.user.id) {
        return res.status(400).json({ error: 'Impossible de vous bannir vous-même.' });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'Compte introuvable.' });

    const tx = db.transaction(() => {
        const pendingBets = db.prepare(`SELECT * FROM bets WHERE user_id = ? AND status = 'pending'`).all(targetId);
        pendingBets.forEach(bet => {
            if (bet.direction === 'YES') {
                db.prepare('UPDATE options SET real_yes = MAX(0, real_yes - ?) WHERE id = ?').run(bet.amount, bet.option_id);
            } else {
                db.prepare('UPDATE options SET real_no = MAX(0, real_no - ?) WHERE id = ?').run(bet.amount, bet.option_id);
            }
        });

        db.prepare('DELETE FROM bets WHERE user_id = ?').run(targetId);
        db.prepare('DELETE FROM group_members WHERE user_id = ?').run(targetId);
        db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
        // Les marchés/groupes déjà créés par ce compte restent en place (ils
        // sont partagés avec d'autres joueurs) — seul le compte disparaît.
    });
    tx();

    res.json({ ok: true });
});

// Crédite (ou débite, avec un montant négatif) le solde d'un compte.
router.post('/users/:id/credit', requireOwner, (req, res) => {
    const targetId = parseInt(req.params.id);
    const amount = Number(req.body && req.body.amount);
    if (!amount || isNaN(amount)) {
        return res.status(400).json({ error: 'Montant invalide.' });
    }

    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
    if (!target) return res.status(404).json({ error: 'Compte introuvable.' });

    const newBalance = Math.max(0, Math.round((target.balance + amount) * 100) / 100);
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, targetId);

    res.json({ ok: true, newBalance });
});

module.exports = router;
