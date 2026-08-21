require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const marketRoutes = require('./routes/markets');
const betRoutes = require('./routes/bets');
const groupRoutes = require('./routes/groups');
const wheelRoutes = require('./routes/wheel');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

// Nécessaire derrière un proxy comme Render pour que req.ip soit la vraie
// adresse du visiteur (utile pour la limitation de tentatives sur le code admin).
app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' })); // 5mb : marge pour les images uploadées en base64
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-moi-en-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production', // HTTPS uniquement en prod
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 jours
    }
}));

app.use('/api/auth', authRoutes);
app.use('/api/markets', marketRoutes);
app.use('/api/bets', betRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/wheel', wheelRoutes);
app.use('/api/admin', adminRoutes);

// Sert le frontend (fichiers statiques : index.html, css, js compilés)
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`✅ EirbMarket lancé sur http://localhost:${PORT}`);
});
