const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'games.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(cache ?? {}, null, 2));
}

function getGuild(guildId) {
  const data = load();
  if (!data[guildId]) {
    data[guildId] = { channels: {}, roleIds: {}, whisperThreads: {}, game: null };
  }
  return data[guildId];
}

module.exports = { load, save, getGuild };
