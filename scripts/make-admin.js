// Usage : node scripts/make-admin.js MonPseudo
// À lancer uniquement par toi, sur le serveur (jamais depuis le navigateur).
// C'est ça qui remplace le "code OENO" côté client : impossible à trouver
// ou à activer en lisant le code source, puisque ça ne vit pas dedans.
const db = require('../src/db');

const username = process.argv[2];
if (!username) {
    console.error('Usage: node scripts/make-admin.js <pseudo>');
    process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
if (!user) {
    console.error(`Aucun utilisateur "${username}" trouvé. Il doit d'abord créer un compte sur le site.`);
    process.exit(1);
}

db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
console.log(`✅ ${username} est maintenant administrateur.`);
