const db = require('./db');

async function requireAuth(req, res, next) {
    try {
        if (!req.session.userId) {
            return res.status(401).json({ error: 'Connectez-vous pour accéder à cette fonctionnalité.' });
        }
        const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
        if (!user) {
            return res.status(401).json({ error: 'Session invalide, reconnectez-vous.' });
        }
        req.user = user;
        next();
    } catch (e) {
        next(e);
    }
}

// L'admin est un DROIT PAR COMPTE stocké en base (is_admin), jamais un simple
// code visible côté client : c'est précisément ce qui empêche de "hacker"
// le mode admin en modifiant le JavaScript du navigateur.
function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user.is_admin) {
            return res.status(403).json({ error: 'Réservé aux administrateurs.' });
        }
        next();
    });
}

// Le "propriétaire" est un cran au-dessus de l'admin : lui seul peut voir
// tous les comptes et tous les paris (modération). Contrairement à is_admin
// (accordé à quiconque connaît le code partagé), is_owner ne peut être
// accordé que via le script scripts/make-owner.js, lancé côté serveur.
function requireOwner(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user.is_owner) {
            return res.status(403).json({ error: 'Réservé au propriétaire du site.' });
        }
        next();
    });
}

module.exports = { requireAuth, requireAdmin, requireOwner };
