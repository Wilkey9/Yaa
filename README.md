# EirbMarket — backend

Ce dossier contient le **vrai serveur** d'EirbMarket : authentification par mot
de passe hashé, base de données, logique de paris/pools/résolution — tout ce
qui doit rester invisible et infalsifiable côté client.

## Ce qui est fait (testé, fonctionnel)

- Inscription / connexion (mot de passe hashé avec bcrypt, jamais stocké en clair)
- Sessions sécurisées (cookie httpOnly)
- **Frontend complet branché sur l'API** (`public/index.html`) : plus aucune
  donnée en `localStorage`, tout passe par `/api/*`
- Code admin partagé, vérifié uniquement côté serveur (jamais visible dans le
  JavaScript envoyé au navigateur)
- Création de marché (admin), binaire ou multi-choix, avec upload d'image
- Système de cagnottes seed/real (pari-mutuel), calculé côté serveur
- Placement de pari, annulation (remboursement 90%)
- Résolution de marché (admin) avec paiement automatique
- Graphique de prix (historique fictif + réel, courbes multiples, curseur de survol)
- Groupes : création, code, rejoindre, sections filtrées côté client
- Roue de la fortune (tirage décidé côté serveur, impossible à truquer)
- Célébration de victoire différée (même après un long moment sans se connecter)
- Limite de 10 marchés créés par semaine et par admin

## Ce qu'il reste à peaufiner

- Les images uploadées sont stockées en base64 directement en base de données
  (simple, fonctionne très bien pour un petit nombre d'utilisateurs, mais à
  terme un service comme Cloudinary ou Supabase Storage serait plus propre)
- Pas encore de page d'erreur ni de gestion des reconnexions réseau perdues
- La migration SQLite → PostgreSQL (Supabase) pour la production, voir plus bas

## Installation locale

```bash
npm install
cp .env.example .env    # puis modifie SESSION_SECRET
npm start
```

Le site tourne sur http://localhost:3000

## Devenir admin

Deux façons de donner les droits admin :

**1. Code partagé (recommandé pour ton usage — "assez ouvert")**

Défini une fois dans `.env` :
```
ADMIN_CODE=UnCodeQueTuChoisis
```
N'importe qui, une fois connecté sur le site, peut se rendre admin en tapant
ce code (route `POST /api/auth/redeem-admin-code`). Le code n'est **jamais**
présent dans le JavaScript envoyé au navigateur — il vit uniquement dans la
variable d'environnement du serveur, donc personne ne peut le retrouver en
lisant le code source du site, seulement en le recevant de toi directement.
Une protection anti-force-brute est incluse (10 tentatives max par 15 min et
par adresse IP).

Comme n'importe quel admin peut créer des marchés (qui injectent chacun un
peu de liquidité fictive de départ, voir `poolMath.js`), la création de
marché est **limitée à 10 par semaine et par admin** pour garder l'économie
du site sous contrôle.

**2. Promotion manuelle (pour toi uniquement, en secours)**

```bash
npm run make-admin TonPseudo
```
Cette commande ne peut être lancée que par toi, directement sur le serveur.
Utile si tu perds/changes le code partagé, ou pour te donner les droits en
tout premier (avant d'avoir communiqué le code à qui que ce soit).

## Devenir propriétaire (modération)

Un cran au-dessus de l'admin : le "propriétaire" est le seul rôle qui peut
voir **tous les comptes et tous les paris du site** (panneau "🛡️ Modération").
Contrairement à l'admin (accordé à quiconque connaît le code partagé), ce
rôle ne peut **jamais** être obtenu depuis le site lui-même — uniquement via :

```bash
npm run make-owner TonPseudo
```

À lancer une seule fois, juste pour toi, après avoir créé ton compte sur le
site. Donne aussi automatiquement les droits admin.

## Déploiement gratuit (Render + Supabase)

### 1. Base de données — Supabase (PostgreSQL gratuit et persistant)

Le fichier SQLite actuel (`data/eirbmarket.db`) fonctionne très bien en local,
mais **ne doit pas être utilisé en production sur Render** : son disque gratuit
est effacé à chaque redémarrage du service. Pour un vrai site :

1. Crée un compte gratuit sur [supabase.com](https://supabase.com)
2. Crée un projet (choisis une région proche de tes utilisateurs, ex: Europe)
3. Récupère l'URL de connexion PostgreSQL (Project Settings → Database)
4. Remplace `better-sqlite3` par `pg` et adapte `src/db.js` pour utiliser
   PostgreSQL au lieu de SQLite (dis-moi quand tu en es là, je peux faire
   cette migration directement).

### 2. Backend — Render (gratuit, sans carte bancaire)

1. Mets ce dossier dans un dépôt GitHub (`git init`, `git add .`, `git commit`, push)
2. Va sur [render.com](https://render.com) → "New +" → "Web Service"
3. Connecte ton dépôt GitHub
4. Render détecte Node.js automatiquement :
   - Build command : `npm install`
   - Start command : `npm start`
5. Ajoute tes variables d'environnement (`SESSION_SECRET`, `DATABASE_URL` une
   fois passé à Postgres) dans l'onglet "Environment"
6. Déploie — ton site est en ligne sur une adresse du type
   `eirbmarket.onrender.com` (gratuite, à vie)

**Limite du gratuit** : le service s'endort après 15 minutes sans visite, et
met 30 à 50 secondes à se réveiller au premier visiteur suivant. Pour
quelques dizaines d'utilisateurs occasionnels, c'est un compromis tout à
fait raisonnable.

### 3. Nom de domaine

Freenom (qui donnait des `.tk`/`.ml` gratuits) a fermé ce service en 2024 —
il n'existe plus vraiment de nom de domaine "propre" gratuit aujourd'hui.
Deux options :
- Garder l'adresse gratuite `eirbmarket.onrender.com` (recommandé pour démarrer)
- Acheter un vrai domaine (`.com`, `.fr`...) chez un registrar comme Namecheap
  ou Hostinger — environ 10-15€/an, puis le brancher sur Render (Settings →
  Custom Domain, gratuit une fois le domaine acheté)

## Structure du projet

```
eirbmarket-server/
  src/
    db.js              # schéma de la base de données
    poolMath.js         # logique pari-mutuel (seed/real, paiements)
    middleware.js        # requireAuth / requireAdmin
    server.js            # point d'entrée
    routes/
      auth.js
      markets.js
      bets.js
      groups.js
  scripts/
    make-admin.js        # promotion admin, à lancer côté serveur uniquement
  public/                 # frontend (à remplacer par eirbmarket.html adapté)
  data/                   # base SQLite locale (jamais commitée sur git)
```
