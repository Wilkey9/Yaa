const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin, optionalAuth } = require('../middleware');
const {
    randomSeedLiquidity, calcOddsFromChance, getOptionChance,
    getOptionRealVolume, getPariMutuelMultiplier
} = require('../poolMath');

const router = express.Router();

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
router.get('/', optionalAuth, async (req, res) => {
    try {
        const joinedGroupIds = req.user
            ? (await db.prepare('SELECT group_id FROM group_members WHERE user_id = ?')
                .all(req.user.id)).map(r => r.group_id)
            : [];

        const placeholders = joinedGroupIds.map(() => '?').join(',');
        const query = joinedGroupIds.length > 0
            ? `SELECT * FROM markets WHERE group_id IS NULL OR group_id IN (${placeholders})`
            : `SELECT * FROM markets WHERE group_id IS NULL`;

        const markets = await db.prepare(query).all(...joinedGroupIds);
        const result = [];
        for (const m of markets) {
            const options = await db.prepare('SELECT * FROM options WHERE market_id = ?').all(m.id);
            result.push(serializeMarket(m, options));
        }
        res.json({ markets: result });
    } catch (err) {
        console.error('Erreur GET /markets :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

router.get('/:id', optionalAuth, async (req, res) => {
    try {
        const market = await db.prepare('SELECT * FROM markets WHERE id = ?').get(req.params.id);
        if (!market) return res.status(404).json({ error: 'Marché introuvable.' });
        const options = await db.prepare('SELECT * FROM options WHERE market_id = ?').all(market.id);
        res.json({ market: serializeMarket(market, options) });
    } catch (err) {
        console.error('Erreur GET /markets/:id :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Historique de prix (fictif + réel) pour le graphique.
router.get('/:id/history', optionalAuth, async (req, res) => {
    try {
        const market = await db.prepare('SELECT * FROM markets WHERE id = ?').get(req.params.id);
        if (!market) return res.status(404).json({ error: 'Marché introuvable.' });
        const options = await db.prepare('SELECT * FROM options WHERE market_id = ?').all(market.id);

        const history = {};
        for (const o of options) {
            const rows = await db.prepare('SELECT t, value FROM price_history WHERE option_id = ? ORDER BY t ASC').all(o.id);
            if (market.market_type === 'binary') {
                history['Oui'] = rows.map(r => ({ t: r.t, value: r.value }));
                history['Non'] = rows.map(r => ({ t: r.t, value: Math.round((100 - r.value) * 10) / 10 }));
            } else {
                history[o.name] = rows.map(r => ({ t: r.t, value: r.value }));
            }
        }

        res.json({ history });
    } catch (err) {
        console.error('Erreur GET /markets/:id/history :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

// Création d'un marché (admin uniquement). Limité à 10 créations/semaine/admin.
const MARKET_CREATION_LIMIT = 10;
const MARKET_CREATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

async function insertFictionalHistory(optionId, values, now) {
    for (let i = 0; i < values.length; i++) {
        const t = now - (FICTIONAL_POINTS - 1 - i) * FICTIONAL_STEP_MS;
        await db.prepare('INSERT INTO price_history (option_id, t, value) VALUES (?, ?, ?)').run(optionId, t, values[i]);
    }
}

async function insertOption(marketId, name, image, seedYes, seedNo) {
    const info = await db.prepare(`
        INSERT INTO options (market_id, name, image, seed_yes, seed_no, real_yes, real_no)
        VALUES (?, ?, ?, ?, ?, 0, 0) RETURNING id
    `).run(marketId, name, image, seedYes, seedNo);
    return info.lastInsertRowid;
}

router.post('/', requireAdmin, async (req, res) => {
    try {
        const { title, category, subtitle, image, marketType, groupId, expiry, yesPrice, options } = req.body || {};

        if (!title || !title.trim()) {
            return res.status(400).json({ error: 'Titre requis.' });
        }

        const since = Date.now() - MARKET_CREATION_WINDOW_MS;
        const recentCount = Number((await db.prepare(
            'SELECT COUNT(*) AS c FROM markets WHERE created_by = ? AND created_at > ?'
        ).get(req.user.id, since)).c);
        if (recentCount >= MARKET_CREATION_LIMIT) {
            return res.status(429).json({
                error: `Limite atteinte : ${MARKET_CREATION_LIMIT} marchés maximum par semaine et par admin.`
            });
        }

        const now = Date.now();
        const displayVolumeOffset = 1000 + Math.random() * 1500;

        const marketInfo = await db.prepare(`
            INSERT INTO markets (title, category, subtitle, image, market_type, group_id, expiry, display_volume_offset, created_by, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
        `).run(
            title.trim(), category || 'GÉNÉRAL', subtitle || '', image || '',
            marketType === 'multi' ? 'multi' : 'binary',
            groupId || null, expiry || '31 Dec 2026', displayVolumeOffset, req.user.id, now
        );
        const marketId = marketInfo.lastInsertRowid;

        if (marketType === 'multi') {
            if (!Array.isArray(options) || options.length < 2) {
                return res.status(400).json({ error: 'Un marché à choix multiples nécessite au moins 2 options.' });
            }
            for (const opt of options) {
                const yp = Math.max(0, Math.min(100, Number(opt.yesPrice) || 0));
                const np = opt.noPrice !== undefined ? Math.max(0, Math.min(100, Number(opt.noPrice))) : (100 - yp);
                const seedTotal = randomSeedLiquidity();
                opt.__optionId = await insertOption(marketId, opt.name, opt.image || '', seedTotal * (yp / 100), seedTotal * (np / 100));
                opt.__yp = yp;
            }

            if (options.length === 2) {
                // Marché à 2 issues : on force la 2e courbe fictive à être
                // l'exact complément de la 1re.
                const values = generateFictionalValues(options[0].__yp);
                await insertFictionalHistory(options[0].__optionId, values, now);
                await insertFictionalHistory(options[1].__optionId, values.map(v => Math.round((100 - v) * 10) / 10), now);
            } else {
                for (const opt of options) {
                    await insertFictionalHistory(opt.__optionId, generateFictionalValues(opt.__yp), now);
                }
            }
        } else {
            const yp = Math.max(0, Math.min(100, Number(yesPrice) || 50));
            const seedTotal = randomSeedLiquidity();
            const optionId = await insertOption(marketId, 'Oui/Non', '', seedTotal * (yp / 100), seedTotal * ((100 - yp) / 100));
            await insertFictionalHistory(optionId, generateFictionalValues(yp), now);
        }

        const market = await db.prepare('SELECT * FROM markets WHERE id = ?').get(marketId);
        const opts = await db.prepare('SELECT * FROM options WHERE market_id = ?').all(marketId);
        res.status(201).json({ market: serializeMarket(market, opts) });
    } catch (e) {
        console.error('Erreur POST /markets :', e);
        res.status(400).json({ error: e.message });
    }
});

// Résolution (admin uniquement).
router.post('/:id/resolve', requireAdmin, async (req, res) => {
    try {
        const market = await db.prepare('SELECT * FROM markets WHERE id = ?').get(req.params.id);
        if (!market) return res.status(404).json({ error: 'Marché introuvable.' });
        if (market.resolved) return res.status(400).json({ error: 'Marché déjà résolu.' });

        const options = await db.prepare('SELECT * FROM options WHERE market_id = ?').all(market.id);

        async function settleBets(optionId, outcome) {
            const option = options.find(o => o.id === optionId);
            const multiplier = getPariMutuelMultiplier(option, outcome);
            const bets = await db.prepare(`SELECT * FROM bets WHERE option_id = ? AND status = 'pending'`).all(optionId);
            for (const bet of bets) {
                const isWinner = (bet.direction === 'YES' && outcome) || (bet.direction === 'NO' && !outcome);
                if (isWinner) {
                    const payout = Math.round(bet.amount * multiplier * 100) / 100;
                    await db.prepare(`UPDATE bets SET status = ?, payout = ?, seen = 0 WHERE id = ?`).run('won', payout, bet.id);
                    await db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(payout, bet.user_id);
                } else {
                    await db.prepare(`UPDATE bets SET status = ?, payout = ?, seen = 0 WHERE id = ?`).run('lost', 0, bet.id);
                }
            }
        }

        if (market.market_type === 'binary') {
            const { winner } = req.body || {};
            if (winner !== 'Oui' && winner !== 'Non') {
                return res.status(400).json({ error: 'Précisez le gagnant : "Oui" ou "Non".' });
            }
            const option = options[0];
            const outcome = winner === 'Oui';
            await db.prepare('UPDATE options SET outcome = ? WHERE id = ?').run(outcome ? 1 : 0, option.id);
            await settleBets(option.id, outcome);
            await db.prepare('UPDATE markets SET resolved = 1 WHERE id = ?').run(market.id);
        } else {
            const { outcomes } = req.body || {};
            if (!outcomes || typeof outcomes !== 'object') {
                return res.status(400).json({ error: 'Précisez le résultat de chaque option.' });
            }
            for (const option of options) {
                if (!(String(option.id) in outcomes)) continue;
                const outcome = !!outcomes[option.id];
                await db.prepare('UPDATE options SET outcome = ? WHERE id = ?').run(outcome ? 1 : 0, option.id);
                await settleBets(option.id, outcome);
            }

            const stillPending = Number((await db.prepare(
                'SELECT COUNT(*) AS c FROM options WHERE market_id = ? AND outcome IS NULL'
            ).get(market.id)).c);
            if (stillPending === 0) {
                await db.prepare('UPDATE markets SET resolved = 1 WHERE id = ?').run(market.id);
            }
        }

        res.json({ ok: true });
    } catch (e) {
        console.error('Erreur POST /markets/:id/resolve :', e);
        res.status(400).json({ error: e.message });
    }
});

router.delete('/:id', requireAdmin, async (req, res) => {
    try {
        // Ordre important pour respecter les clés étrangères : price_history
        // référence options, qui référence markets. On purge l'historique
        // AVANT les options, sinon PostgreSQL refuse la suppression des
        // options (contrainte de clé étrangère violée).
        const optionIds = (await db.prepare('SELECT id FROM options WHERE market_id = ?').all(req.params.id)).map(o => o.id);
        for (const optId of optionIds) {
            await db.prepare('DELETE FROM price_history WHERE option_id = ?').run(optId);
        }
        await db.prepare('DELETE FROM bets WHERE market_id = ?').run(req.params.id);
        await db.prepare('DELETE FROM options WHERE market_id = ?').run(req.params.id);
        await db.prepare('DELETE FROM markets WHERE id = ?').run(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        console.error('Erreur DELETE /markets/:id :', err);
        res.status(500).json({ error: 'Erreur serveur.' });
    }
});

module.exports = router;
