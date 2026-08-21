const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware');
const {
    randomSeedLiquidity, calcOddsFromChance, getOptionChance,
    getOptionRealVolume, getPariMutuelMultiplier
} = require('../poolMath');

const router = express.Router();

// Sérialise un marché + ses options pour le client, sans jamais exposer les
// colonnes internes (seed_yes/real_no bruts) : seulement le %/cote calculés.
//
// Cas particulier binaire : il n'y a qu'UNE SEULE ligne en base (Oui et Non
// partagent la même paire de cagnottes), mais le client affiche 2 lignes
// "Oui"/"Non" -> on les synthétise ici, toutes deux pointant vers le même
// optionId (le serveur retrouve la bonne direction YES/NO à partir du nom).
function serializeMarket(market, options) {
    const realVolume = options.reduce((sum, o) => sum + getOptionRealVolume(o), 0);
    const totalVolume = realVolume + (market.display_volume_offset || 0);

    let serializedOptions;
    if (market.market_type === 'binary') {
        const o = options[0];
        const yesChance = getOptionChance(o);
        const noChance = Math.round((100 - yesChance) * 10) / 10;
        serializedOptions = [
            { id: o.id, name: 'Oui', image: '', chance: yesChance, odds: calcOddsFromChance(yesChance), outcome: o.outcome === null ? null : !!o.outcome },
            { id: o.id, name: 'Non', image: '', chance: noChance, odds: calcOddsFromChance(noChance), outcome: o.outcome === null ? null : !o.outcome }
        ];
    } else {
        serializedOptions = options.map(o => ({
            id: o.id,
            name: o.name,
            image: o.image,
            chance: getOptionChance(o),
            odds: calcOddsFromChance(getOptionChance(o)),
            outcome: o.outcome === null ? null : !!o.outcome
        }));
    }

    return {
        id: market.id,
        title: market.title,
        category: market.category,
        subtitle: market.subtitle,
        image: market.image,
        marketType: market.market_type,
        groupId: market.group_id,
        expiry: market.expiry,
        resolved: !!market.resolved,
        volume: Math.round(totalVolume * 100) / 100,
        options: serializedOptions
    };
}

// Marchés visibles par l'utilisateur connecté : Général + groupes rejoints.
router.get('/', requireAuth, (req, res) => {
    const joinedGroupIds = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
        .all(req.user.id).map(r => r.group_id);

    const placeholders = joinedGroupIds.map(() => '?').join(',');
    const query = joinedGroupIds.length > 0
        ? `SELECT * FROM markets WHERE group_id IS NULL OR group_id IN (${placeholders})`
        : `SELECT * FROM markets WHERE group_id IS NULL`;

    const markets = db.prepare(query).all(...joinedGroupIds);
    const result = markets.map(m => {
        const options = db.prepare('SELECT * FROM options WHERE market_id = ?').all(m.id);
        return serializeMarket(m, options);
    });
    res.json({ markets: result });
});

router.get('/:id', requireAuth, (req, res) => {
    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(req.params.id);
    if (!market) return res.status(404).json({ error: 'Marché introuvable.' });
    const options = db.prepare('SELECT * FROM options WHERE market_id = ?').all(market.id);
    res.json({ market: serializeMarket(market, options) });
});

// Historique de prix (fictif + réel) pour le graphique : un tableau de
// points par option, chacun { t: timestamp, value: chance% }.
router.get('/:id/history', requireAuth, (req, res) => {
    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(req.params.id);
    if (!market) return res.status(404).json({ error: 'Marché introuvable.' });
    const options = db.prepare('SELECT * FROM options WHERE market_id = ?').all(market.id);

    const history = {};
    options.forEach(o => {
        const rows = db.prepare('SELECT t, value FROM price_history WHERE option_id = ? ORDER BY t ASC').all(o.id);
        // Le nom affiché pour un marché binaire dépend du côté (Oui = value, Non = 100 - value).
        if (market.market_type === 'binary') {
            history['Oui'] = rows.map(r => ({ t: r.t, value: r.value }));
            history['Non'] = rows.map(r => ({ t: r.t, value: Math.round((100 - r.value) * 10) / 10 }));
        } else {
            history[o.name] = rows.map(r => ({ t: r.t, value: r.value }));
        }
    });

    res.json({ history });
});

// Création d'un marché (admin uniquement). Corps attendu :
// { title, category, subtitle, image, marketType: 'binary'|'multi', groupId,
//   expiry, yesPrice (binaire), options: [{name, yesPrice, noPrice, image}] (multi) }
//
// Limité à 10 créations par semaine et par admin : comme le code admin est
// partagé (n'importe qui en possession du code devient admin), c'est ce qui
// empêche la création incontrôlée de monnaie fictive (chaque marché injecte
// une petite liquidité de départ, voir poolMath.js).
const MARKET_CREATION_LIMIT = 10;
const MARKET_CREATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Historique fictif (13 points espacés de 5 min sur l'heure précédente,
// se terminant PILE sur le prix réel de départ) pour que le graphique
// d'un marché flambant neuf ne parte pas d'une page blanche.
const FICTIONAL_POINTS = 13;
const FICTIONAL_STEP_MS = 5 * 60 * 1000;

function generateFictionalValues(targetChance) {
    const volatility = 2 + Math.random() * 2;
    const values = new Array(FICTIONAL_POINTS);
    values[FICTIONAL_POINTS - 1] = targetChance;
    for (let i = FICTIONAL_POINTS - 2; i >= 0; i--) {
        const change = (Math.random() - 0.5) * volatility * 2;
        values[i] = Math.max(0.5, Math.min(99.5, values[i + 1] + change));
    }
    return values.map(v => Math.round(v * 10) / 10);
}

function insertFictionalHistory(optionId, values, now) {
    const insert = db.prepare('INSERT INTO price_history (option_id, t, value) VALUES (?, ?, ?)');
    values.forEach((v, i) => {
        const t = now - (FICTIONAL_POINTS - 1 - i) * FICTIONAL_STEP_MS;
        insert.run(optionId, t, v);
    });
}

router.post('/', requireAdmin, (req, res) => {
    const { title, category, subtitle, image, marketType, groupId, expiry, yesPrice, options } = req.body || {};

    if (!title || !title.trim()) {
        return res.status(400).json({ error: 'Titre requis.' });
    }

    const since = Date.now() - MARKET_CREATION_WINDOW_MS;
    const recentCount = db.prepare(
        'SELECT COUNT(*) AS c FROM markets WHERE created_by = ? AND created_at > ?'
    ).get(req.user.id, since).c;
    if (recentCount >= MARKET_CREATION_LIMIT) {
        return res.status(429).json({
            error: `Limite atteinte : ${MARKET_CREATION_LIMIT} marchés maximum par semaine et par admin.`
        });
    }

    const now = Date.now();
    // Volume de départ purement cosmétique (voir commentaire sur la colonne),
    // pour qu'un marché flambant neuf n'affiche jamais "0Ɇ" misé.
    const displayVolumeOffset = 1000 + Math.random() * 1500;
    const insertMarket = db.prepare(`
        INSERT INTO markets (title, category, subtitle, image, market_type, group_id, expiry, display_volume_offset, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertOption = db.prepare(`
        INSERT INTO options (market_id, name, image, seed_yes, seed_no, real_yes, real_no)
        VALUES (?, ?, ?, ?, ?, 0, 0)
    `);

    const tx = db.transaction(() => {
        const marketInfo = insertMarket.run(
            title.trim(), category || 'GÉNÉRAL', subtitle || '', image || '',
            marketType === 'multi' ? 'multi' : 'binary',
            groupId || null, expiry || '31 Dec 2026', displayVolumeOffset, req.user.id, now
        );
        const marketId = marketInfo.lastInsertRowid;

        if (marketType === 'multi') {
            if (!Array.isArray(options) || options.length < 2) {
                throw new Error('Un marché à choix multiples nécessite au moins 2 options.');
            }
            options.forEach(opt => {
                const yp = Math.max(0, Math.min(100, Number(opt.yesPrice) || 0));
                const np = opt.noPrice !== undefined ? Math.max(0, Math.min(100, Number(opt.noPrice))) : (100 - yp);
                const seedTotal = randomSeedLiquidity();
                const optInfo = insertOption.run(marketId, opt.name, opt.image || '', seedTotal * (yp / 100), seedTotal * (np / 100));
                opt.__optionId = optInfo.lastInsertRowid;
                opt.__yp = yp;
            });

            if (options.length === 2) {
                // Marché à 2 issues (comme un binaire) : on force la 2e courbe
                // fictive à être l'exact complément de la 1re, pour que ça
                // somme toujours à 100% et ne trahisse pas les fausses données.
                const values = generateFictionalValues(options[0].__yp);
                insertFictionalHistory(options[0].__optionId, values, now);
                insertFictionalHistory(options[1].__optionId, values.map(v => Math.round((100 - v) * 10) / 10), now);
            } else {
                options.forEach(opt => {
                    insertFictionalHistory(opt.__optionId, generateFictionalValues(opt.__yp), now);
                });
            }
        } else {
            // Marché binaire : UNE SEULE ligne d'option porte les 2 côtés
            // (Oui = "yes", Non = "no") -> ils sont donc TOUJOURS complémentaires,
            // impossible de les décorréler comme ce serait le cas avec 2 lignes.
            const yp = Math.max(0, Math.min(100, Number(yesPrice) || 50));
            const seedTotal = randomSeedLiquidity();
            const optInfo = insertOption.run(marketId, 'Oui/Non', '', seedTotal * (yp / 100), seedTotal * ((100 - yp) / 100));
            insertFictionalHistory(optInfo.lastInsertRowid, generateFictionalValues(yp), now);
        }

        return marketId;
    });

    try {
        const marketId = tx();
        const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
        const opts = db.prepare('SELECT * FROM options WHERE market_id = ?').all(marketId);
        res.status(201).json({ market: serializeMarket(market, opts) });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Résolution (admin uniquement). Corps attendu :
// - Binaire : { winner: 'Oui' | 'Non' }
// - Multi : { outcomes: { [optionId]: true|false, ... } } (chaque option indépendante)
router.post('/:id/resolve', requireAdmin, (req, res) => {
    const market = db.prepare('SELECT * FROM markets WHERE id = ?').get(req.params.id);
    if (!market) return res.status(404).json({ error: 'Marché introuvable.' });
    if (market.resolved) return res.status(400).json({ error: 'Marché déjà résolu.' });

    const options = db.prepare('SELECT * FROM options WHERE market_id = ?').all(market.id);

    const setOutcome = db.prepare('UPDATE options SET outcome = ? WHERE id = ?');
    const setResolved = db.prepare('UPDATE markets SET resolved = 1 WHERE id = ?');
    const getPendingBets = db.prepare(`SELECT * FROM bets WHERE market_id = ? AND status = 'pending'`);
    const updateBet = db.prepare(`UPDATE bets SET status = ?, payout = ?, seen = 0 WHERE id = ?`);
    const creditUser = db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?');

    const tx = db.transaction(() => {
        if (market.market_type === 'binary') {
            const { winner } = req.body || {};
            if (winner !== 'Oui' && winner !== 'Non') {
                throw new Error('Précisez le gagnant : "Oui" ou "Non".');
            }
            const option = options[0]; // une seule ligne pour un marché binaire
            const outcome = winner === 'Oui'; // true = Oui a gagné, false = Non
            setOutcome.run(outcome ? 1 : 0, option.id);

            const multiplier = getPariMutuelMultiplier(option, outcome);
            const bets = getPendingBets.all(market.id);
            bets.forEach(bet => {
                const isWinner = (bet.direction === 'YES' && outcome) || (bet.direction === 'NO' && !outcome);
                if (isWinner) {
                    const payout = Math.round(bet.amount * multiplier * 100) / 100;
                    updateBet.run('won', payout, bet.id);
                    creditUser.run(payout, bet.user_id);
                } else {
                    updateBet.run('lost', 0, bet.id);
                }
            });
        } else {
            const { outcomes } = req.body || {};
            if (!outcomes || typeof outcomes !== 'object') {
                throw new Error('Précisez le résultat de chaque option.');
            }
            options.forEach(option => {
                if (!(String(option.id) in outcomes)) return; // option pas encore résolue
                const outcome = !!outcomes[option.id];
                setOutcome.run(outcome ? 1 : 0, option.id);

                const multiplier = getPariMutuelMultiplier(option, outcome);
                const bets = db.prepare(`SELECT * FROM bets WHERE option_id = ? AND status = 'pending'`).all(option.id);
                bets.forEach(bet => {
                    const isWinner = (bet.direction === 'YES' && outcome) || (bet.direction === 'NO' && !outcome);
                    if (isWinner) {
                        const payout = Math.round(bet.amount * multiplier * 100) / 100;
                        updateBet.run('won', payout, bet.id);
                        creditUser.run(payout, bet.user_id);
                    } else {
                        updateBet.run('lost', 0, bet.id);
                    }
                });
            });

            // Le marché n'est marqué "résolu" que si TOUTES les options le sont.
            const stillPending = db.prepare('SELECT COUNT(*) AS c FROM options WHERE market_id = ? AND outcome IS NULL').get(market.id);
            if (stillPending.c > 0) return; // résolution partielle, on s'arrête là
        }
        setResolved.run(market.id);
    });

    try {
        tx();
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM bets WHERE market_id = ?').run(req.params.id);
    db.prepare('DELETE FROM options WHERE market_id = ?').run(req.params.id);
    db.prepare('DELETE FROM markets WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

module.exports = router;
