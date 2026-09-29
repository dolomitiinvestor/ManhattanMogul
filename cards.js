(() => {
// All game content lives here: rename colors, properties, and actions freely.
// Changing counts or values changes the deck. Keys (e.g. 'brown', 'slyDeal')
// are internal ids used by the engine and should stay the same.

const COLORS = {
  brown:     { name: 'Brown',      hex: '#8B5A2B', size: 2, rent: [1, 2] },
  lightBlue: { name: 'Light Blue', hex: '#8FD3F4', size: 3, rent: [1, 2, 3] },
  pink:      { name: 'Pink',       hex: '#D63C9A', size: 3, rent: [1, 2, 4] },
  orange:    { name: 'Orange',     hex: '#F28C28', size: 3, rent: [1, 3, 5] },
  red:       { name: 'Red',        hex: '#E03131', size: 3, rent: [2, 3, 6] },
  yellow:    { name: 'Yellow',     hex: '#F5D90A', size: 3, rent: [2, 4, 6] },
  green:     { name: 'Green',      hex: '#2B9348', size: 3, rent: [2, 4, 7] },
  darkBlue:  { name: 'Dark Blue',  hex: '#1C3F95', size: 2, rent: [3, 8] },
  railroad:  { name: 'Railroad',   hex: '#222222', size: 4, rent: [1, 2, 3, 4], noBuildings: true },
  utility:   { name: 'Utility',    hex: '#A3B18A', size: 2, rent: [1, 2], noBuildings: true },
};

// Property cards: one entry per card.
const PROPERTIES = [
  { color: 'brown', value: 1, name: 'Park Slope' },
  { color: 'brown', value: 1, name: 'Red Hook' },
  { color: 'lightBlue', value: 1, name: 'Williamsburg' },
  { color: 'lightBlue', value: 1, name: 'Greenpoint' },
  { color: 'lightBlue', value: 1, name: 'Buschwick' },
  { color: 'pink', value: 2, name: 'Fidi' },
  { color: 'pink', value: 2, name: 'Dumbo' },
  { color: 'pink', value: 2, name: 'Tribeca' },
  { color: 'orange', value: 2, name: 'The East Village' },
  { color: 'orange', value: 2, name: 'Lower East Side' },
  { color: 'orange', value: 2, name: 'Dimes Square' },
  { color: 'red', value: 3, name: 'Flatiron' },
  { color: 'red', value: 3, name: 'Union Sq' },
  { color: 'red', value: 3, name: 'Washington Sq Park' },
  { color: 'yellow', value: 3, name: 'Upper East Side' },
  { color: 'yellow', value: 3, name: 'Lennox Hill' },
  { color: 'yellow', value: 3, name: 'Long Island City' },
  { color: 'green', value: 4, name: 'Upper West Side' },
  { color: 'green', value: 4, name: 'Lincoln Center' },
  { color: 'green', value: 4, name: 'Manhattanville' },
  { color: 'darkBlue', value: 4, name: 'West Village' },
  { color: 'darkBlue', value: 4, name: 'Soho' },
  { color: 'railroad', value: 2, name: 'Times Square' },
  { color: 'railroad', value: 2, name: 'Penn Station' },
  { color: 'railroad', value: 2, name: 'Grand Central' },
  { color: 'railroad', value: 2, name: 'NJT/LIRR' },
  { color: 'utility', value: 2, name: 'ConEd' },
  { color: 'utility', value: 2, name: 'Spectrum' },
];

// Wild property cards. colors: two color ids, or 'any' for the multi-color wild.
const WILDS = [
  { colors: ['darkBlue', 'green'], value: 4, count: 1 },
  { colors: ['green', 'railroad'], value: 4, count: 1 },
  { colors: ['utility', 'railroad'], value: 2, count: 1 },
  { colors: ['lightBlue', 'railroad'], value: 4, count: 1 },
  { colors: ['lightBlue', 'brown'], value: 1, count: 1 },
  { colors: ['pink', 'orange'], value: 2, count: 2 },
  { colors: ['red', 'yellow'], value: 3, count: 2 },
  { colors: 'any', value: 0, count: 2, name: 'Property Wild Card' },
];

// Action cards. The key is the engine id; name/description are display text.
const ACTIONS = {
  dealBreaker:  { name: 'NYC Hustle',     value: 5, count: 2,  desc: 'Steal a complete set of properties from any player (includes any House/Hotel).' },
  justSayNo:    { name: 'Just Say No',      value: 4, count: 3,  desc: 'Use any time to cancel an action played against you. Can counter another Just Say No.' },
  slyDeal:      { name: 'New York or Nowhere',         value: 3, count: 3,  desc: 'Steal a property from any player. Cannot be part of a complete set.' },
  forcedDeal:   { name: 'Sneaky Link',      value: 3, count: 3,  desc: 'Swap one of your properties with another player\'s. Neither can be part of a complete set.' },
  debtCollector:{ name: 'The IRS',   value: 3, count: 3,  desc: 'Force any one player to pay you $5M.' },
  birthday:     { name: "Partiful Birthday", value: 2, count: 3,  desc: 'All players give you $2M as a gift.' },
  passGo:       { name: 'Core Memory',          value: 1, count: 10, desc: 'Draw 2 extra cards.' },
  house:        { name: 'Condo Assessment',            value: 3, count: 3,  desc: 'Add onto a complete set to add $3M to its rent. Not on Railroads or Utilities.' },
  hotel:        { name: 'Mansion Tax',            value: 4, count: 3,  desc: 'Add onto a complete set with a House to add $4M to its rent. Not on Railroads or Utilities.' },
  doubleRent:   { name: 'Rent Increase',  value: 1, count: 2,  desc: 'Play with a Rent card to double the rent. Counts as one of your 3 plays.' },
};

// Extra action cards only shuffled in when the host turns on "Enhanced" mode.
const ENHANCED_ACTIONS = {
  mamdani:      { name: 'Mamdani',   value: 2, count: 2,  desc: 'Everyone (you included) draws 1 card.' },
  ericAdams:    { name: 'Eric Adams', value: 3, count: 2, desc: 'Draw 3 extra cards.' },
};

// Rent cards. colors: two color ids (charges all players) or 'any' (charges one player).
const RENTS = [
  { colors: ['darkBlue', 'green'], value: 1, count: 2 },
  { colors: ['red', 'yellow'], value: 1, count: 2 },
  { colors: ['pink', 'orange'], value: 1, count: 2 },
  { colors: ['lightBlue', 'brown'], value: 1, count: 2 },
  { colors: ['railroad', 'utility'], value: 1, count: 2 },
  { colors: 'any', value: 3, count: 3 },
];

// Money cards: value -> count.
const MONEY = { 1: 6, 2: 5, 3: 3, 4: 3, 5: 2, 10: 1 };

const BUILDING_RENT = { house: 3, hotel: 4 };

const RULES = {
  handSize: 5,          // cards dealt at the start
  drawPerTurn: 2,
  drawWhenEmpty: 5,     // draw this many instead if you start your turn with no cards
  playsPerTurn: 3,
  maxHand: 7,
  setsToWin: 3,
  debtCollectorAmount: 5,
  birthdayAmount: 2,
  passGoDraw: 2,
  mamdaniDraw: 1,
  ericAdamsDraw: 3,
  minPlayers: 2,
  maxPlayers: 10,
  playersPerDeck: 5,    // above this, an extra deck is shuffled in
};

let nextId = 1;
function buildDeck(copies = 1, { enhanced = false } = {}) {
  const deck = [];
  const add = (card) => deck.push({ id: 'c' + nextId++, ...card });
  for (let n = 0; n < copies; n++) {
    for (const [value, count] of Object.entries(MONEY)) {
      for (let i = 0; i < count; i++) add({ type: 'money', value: Number(value), name: `$${value}M` });
    }
    for (const p of PROPERTIES) add({ type: 'property', color: p.color, value: p.value, name: p.name });
    for (const w of WILDS) {
      for (let i = 0; i < w.count; i++) {
        const name = w.name || `${COLORS[w.colors[0]].name} / ${COLORS[w.colors[1]].name} Wild`;
        add({ type: 'wild', colors: w.colors, value: w.value, name });
      }
    }
    const actions = enhanced ? { ...ACTIONS, ...ENHANCED_ACTIONS } : ACTIONS;
    for (const [key, a] of Object.entries(actions)) {
      for (let i = 0; i < a.count; i++) add({ type: 'action', action: key, value: a.value, name: a.name, desc: a.desc });
    }
    for (const r of RENTS) {
      for (let i = 0; i < r.count; i++) {
        const name = r.colors === 'any' ? 'Wild Rent' : `Rent: ${COLORS[r.colors[0]].name} / ${COLORS[r.colors[1]].name}`;
        const desc = r.colors === 'any'
          ? 'Charge ONE player rent for any one of your property sets.'
          : 'Charge ALL players rent for one of your sets of these colors.';
        add({ type: 'rent', colors: r.colors, value: r.value, name, desc });
      }
    }
  }
  return deck;
}

const api = { COLORS, ACTIONS, ENHANCED_ACTIONS, BUILDING_RENT, RULES, buildDeck };
if (typeof module !== 'undefined') module.exports = api; else window.MMCards = api;
})();
