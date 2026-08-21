// ============================================================
// SYSTÈME DE CAGNOTTES (PARI-MUTUEL) — logique serveur
// ============================================================
// Identique au modèle conçu côté client : chaque option a une part "seed"
// (liquidité fictive de départ, injecte une petite inflation contrôlée à la
// résolution) et une part "real" (argent réellement misé).

const SEED_LIQUIDITY_MIN = 3995;
const SEED_LIQUIDITY_MAX = 4500;

function randomSeedLiquidity() {
    return SEED_LIQUIDITY_MIN + Math.random() * (SEED_LIQUIDITY_MAX - SEED_LIQUIDITY_MIN);
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

function calcOddsFromChance(chance) {
    return chance > 0 ? (100 / chance).toFixed(2) + 'x' : '1.00x';
}

// Chance (%) affichée pour une option, à partir de ses cagnottes.
function getOptionChance(option) {
    const yes = option.seed_yes + option.real_yes;
    const no = option.seed_no + option.real_no;
    const total = yes + no;
    return total > 0 ? round1((yes / total) * 100) : 50;
}

// Prix (%) auquel un pari serait exécuté maintenant, selon la direction.
function getOptionPrice(option, direction) {
    const yes = option.seed_yes + option.real_yes;
    const no = option.seed_no + option.real_no;
    const total = yes + no;
    const yesChance = total > 0 ? (yes / total) * 100 : 50;
    return round1(direction === 'YES' ? yesChance : 100 - yesChance);
}

// Volume réel (Ɇ) misé sur une option (hors liquidité de départ fictive).
function getOptionRealVolume(option) {
    return (option.real_yes || 0) + (option.real_no || 0);
}

// Multiplicateur de paiement pari-mutuel une fois l'option résolue (outcome
// = true/false) : (cagnotte totale gagnante + perdante) / cagnotte gagnante.
// Inclut le seed -> une petite inflation contrôlée, plafonnée au seed tiré.
function getPariMutuelMultiplier(option, outcome) {
    const yesTotal = option.seed_yes + option.real_yes;
    const noTotal = option.seed_no + option.real_no;
    const winningPool = outcome ? yesTotal : noTotal;
    const losingPool = outcome ? noTotal : yesTotal;
    if (!winningPool || winningPool <= 0) return 0;
    return (winningPool + losingPool) / winningPool;
}

module.exports = {
    randomSeedLiquidity,
    round1,
    calcOddsFromChance,
    getOptionChance,
    getOptionPrice,
    getOptionRealVolume,
    getPariMutuelMultiplier
};
