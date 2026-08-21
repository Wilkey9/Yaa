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

// Groupes rejoints par l'utilisateur connecté (sans le code : pas besoin de
// le connaître une fois membre).
router.get('/mine', requireAuth, (req, res) => {
    const rows = db.prepare(`
        SELECT groups.id, groups.name, groups.image
        FROM group_members
        JOIN groups ON groups.id = group_members.group_id
        WHERE group_members.user_id = ?
    `).all(req.user.id);
    res.json({ groups: rows });
});

// Groupes créés par l'admin connecté, code inclus (lui seul peut le voir ici).
router.get('/created', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT id, name, image, code FROM groups WHERE created_by = ?').all(req.user.id);
    res.json({ groups: rows });
});

router.post('/', requireAdmin, (req, res) => {
    const { name, image } = req.body || {};
    if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Nom de groupe requis.' });
    }

    let code;
    do { code = generateGroupCode(); } while (db.prepare('SELECT id FROM groups WHERE code = ?').get(code));

    const tx = db.transaction(() => {
        const info = db.prepare('INSERT INTO groups (name, image, code, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(name.trim(), image || '', code, req.user.id, Date.now());
        // Le créateur rejoint automatiquement son propre groupe.
        db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
            .run(info.lastInsertRowid, req.user.id, Date.now());
        return info.lastInsertRowid;
    });

    const groupId = tx();
    res.status(201).json({ group: { id: groupId, name: name.trim(), image: image || '', code } });
});

router.post('/join', requireAuth, (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Code requis.' });

    const group = db.prepare('SELECT * FROM groups WHERE code = ?').get(code.trim().toUpperCase());
    if (!group) return res.status(404).json({ error: 'Code invalide.' });

    const already = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.user.id);
    if (already) {
        return res.json({ group: { id: group.id, name: group.name, image: group.image }, alreadyJoined: true });
    }

    db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
        .run(group.id, req.user.id, Date.now());
    res.json({ group: { id: group.id, name: group.name, image: group.image }, alreadyJoined: false });
});

module.exports = router;
