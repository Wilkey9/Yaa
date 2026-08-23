const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware');

const router = express.Router();

function generateGroupCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

// Groupes rejoints par l'utilisateur connecté.
router.get('/mine', requireAuth, async (req, res) => {
    try {
        const rows = await db.prepare(`
            SELECT groups.id, groups.name, groups.image
            FROM group_members
            JOIN groups ON groups.id = group_members.group_id
            WHERE group_members.user_id = ?
        `).all(req.user.id);
        res.json({ groups: rows });
    } catch (err) {
        console.error('Erreur GET /groups/mine :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Groupes créés par l'admin connecté, code inclus.
router.get('/created', requireAdmin, async (req, res) => {
    try {
        const rows = await db.prepare('SELECT id, name, image, code FROM groups WHERE created_by = ?').all(req.user.id);
        res.json({ groups: rows });
    } catch (err) {
        console.error('Erreur GET /groups/created :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

router.post('/', requireAdmin, async (req, res) => {
    try {
        const { name, image } = req.body || {};
        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'Nom de groupe requis.' });
        }

        let code;
        let existing;
        do {
            code = generateGroupCode();
            existing = await db.prepare('SELECT id FROM groups WHERE code = ?').get(code);
        } while (existing);

        const info = await db.prepare(
            'INSERT INTO groups (name, image, code, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
        ).run(name.trim(), image || '', code, req.user.id, Date.now());
        const groupId = info.lastInsertRowid;

        // Le créateur rejoint automatiquement son propre groupe.
        await db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
            .run(groupId, req.user.id, Date.now());

        res.status(201).json({ group: { id: groupId, name: name.trim(), image: image || '', code } });
    } catch (err) {
        console.error('Erreur POST /groups :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

router.post('/join', requireAuth, async (req, res) => {
    try {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ error: 'Code requis.' });

        const group = await db.prepare('SELECT * FROM groups WHERE code = ?').get(code.trim().toUpperCase());
        if (!group) return res.status(404).json({ error: 'Code invalide.' });

        const already = await db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.user.id);
        if (already) {
            return res.json({ group: { id: group.id, name: group.name, image: group.image }, alreadyJoined: true });
        }

        await db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
            .run(group.id, req.user.id, Date.now());
        res.json({ group: { id: group.id, name: group.name, image: group.image }, alreadyJoined: false });
    } catch (err) {
        console.error('Erreur POST /groups/join :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

module.exports = router;
