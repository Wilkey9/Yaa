require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');

const db = require('./db');
const authRoutes = require('./routes/auth');
const marketRoutes = require('./routes/markets');
const betRoutes = require('./routes/bets');
const groupRoutes = require('./routes/groups');
const wheelRoutes = require('./routes/wheel');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '5mb' }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-moi-en-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000
    }
}));

app.use('/api/auth', authRoutes);
app.use('/api/markets', marketRoutes);
app.use('/api/bets', betRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/wheel', wheelRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function start() {
    await db.initSchema();
    app.listen(PORT, () => {
        console.log(`✅ EirbMarket lancé sur http://localhost:${PORT}`);
    });
}

start().catch(err => {
    console.error('❌ Erreur au démarrage :', err);
    process.exit(1);
});
