// Usage : node scripts/make-owner.js MonPseudo
// À lancer uniquement par toi, sur le serveur (jamais depuis le navigateur).
// Donne accès à la modération (voir tous les comptes et tous les paris) —
// un cran au-dessus de is_admin, que n'importe qui avec le code partagé peut
// obtenir. is_owner, lui, ne peut JAMAIS être accordé depuis le site.
const db = require('../src/db');

const username = process.argv[2];
if (!username) {
    console.error('Usage: node scripts/make-owner.js <pseudo>');
    process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!user) {
    console.error(`Aucun utilisateur "${username}" trouvé. Il doit d'abord créer un compte sur le site.`);
    process.exit(1);
}

db.prepare('UPDATE users SET is_owner = 1, is_admin = 1 WHERE id = ?').run(user.id);
console.log(`✅ ${username} est maintenant propriétaire du site (accès modération + admin).`);
