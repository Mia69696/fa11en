require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { client, state, addLog, addWarning, clearWarnings, addInfraction } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const DISCORD = 'https://discord.com/api/v10';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

async function dapi(endpoint) {
  const r = await fetch(DISCORD + endpoint, { headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' } });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return { error: txt }; }
}

// ── BOT INFO ──────────────────────────────────────────
app.get('/api/bot', async (req, res) => {
  try {
    const t0 = Date.now();
    const d = await dapi('/users/@me');
    res.json({ ...d, _ping: Date.now() - t0, _wsPing: client.ws?.ping || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GUILDS ────────────────────────────────────────────
app.get('/api/guilds', async (req, res) => {
  try {
    const guilds = await dapi('/users/@me/guilds');
    if (!Array.isArray(guilds)) return res.json(guilds);
    const detailed = await Promise.all(guilds.map(async g => {
      try {
        const full = await dapi('/guilds/' + g.id + '?with_counts=true');
        return { id: g.id, name: g.name, icon: g.icon, owner: g.owner, member_count: full.approximate_member_count || 0, presence_count: full.approximate_presence_count || 0 };
      } catch { return { id: g.id, name: g.name, icon: g.icon, owner: g.owner, member_count: 0 }; }
    }));
    res.json(detailed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MEMBERS ───────────────────────────────────────────
app.get('/api/guilds/:id/members', async (req, res) => {
  try { res.json(await dapi('/guilds/' + req.params.id + '/members?limit=100')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CHANNELS ──────────────────────────────────────────
app.get('/api/guilds/:id/channels', async (req, res) => {
  try { res.json(await dapi('/guilds/' + req.params.id + '/channels')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ROLES ─────────────────────────────────────────────
app.get('/api/guilds/:id/roles', async (req, res) => {
  try { res.json(await dapi('/guilds/' + req.params.id + '/roles')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS GET/SET ──────────────────────────────────
app.get('/api/settings', (req, res) => {
  res.json({
    blockInvites: state.blockInvites, blockSpam: state.blockSpam,
    badWordsFilter: state.badWordsFilter, blockMassMentions: state.blockMassMentions,
    capsFilter: state.capsFilter, blockLinks: state.blockLinks,
    welcomeEnabled: state.welcomeEnabled, goodbyeEnabled: state.goodbyeEnabled,
    levelingEnabled: state.levelingEnabled, ticketsEnabled: state.ticketsEnabled,
    welcomeMessage: state.welcomeMessage, goodbyeMessage: state.goodbyeMessage,
    levelUpMessage: state.levelUpMessage, welcomeChannelId: state.welcomeChannelId,
    logChannelId: state.logChannelId, autobanThreshold: state.autobanThreshold,
    prefix: state.prefix, muteMinutes: state.muteMinutes, badWordsList: state.badWordsList,
  });
});

app.post('/api/settings', (req, res) => {
  const allowed = ['blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
    'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled','welcomeMessage','goodbyeMessage',
    'levelUpMessage','welcomeChannelId','logChannelId','autobanThreshold','prefix','muteMinutes','badWordsList'];
  allowed.forEach(k => { if (req.body[k] !== undefined) state[k] = req.body[k]; });
  addLog('DASH', 'settings updated from dashboard', 'blue');
  res.json({ ok: true });
});

// ── TOGGLE ────────────────────────────────────────────
app.post('/api/toggle', (req, res) => {
  const { key, value } = req.body;
  const allowed = ['blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
    'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'invalid key' });
  state[key] = value;
  addLog('DASH', `${key} set to ${value}`, value ? 'green' : 'yellow');
  res.json({ ok: true, [key]: state[key] });
});

// ── BAN ───────────────────────────────────────────────
app.post('/api/action/ban', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    await guild.members.ban(userId, { reason: reason || 'banned from dashboard' });
    addInfraction(userId, 'ban', reason || 'dashboard ban');
    addLog('MOD', `${userId} banned from dashboard`, 'red');
    res.json({ ok: true, message: 'user banned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KICK ──────────────────────────────────────────────
app.post('/api/action/kick', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const member = await guild.members.fetch(userId);
    await member.kick(reason || 'kicked from dashboard');
    addInfraction(userId, 'kick', reason || 'dashboard kick');
    addLog('MOD', `${userId} kicked from dashboard`, 'red');
    res.json({ ok: true, message: 'user kicked' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TIMEOUT ───────────────────────────────────────────
app.post('/api/action/timeout', async (req, res) => {
  const { guildId, userId, minutes, reason } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const member = await guild.members.fetch(userId);
    await member.timeout((minutes || 10) * 60000, reason || 'timeout from dashboard');
    addInfraction(userId, 'timeout', reason || 'dashboard timeout');
    addLog('MOD', `${userId} timed out ${minutes || 10}min from dashboard`, 'yellow');
    res.json({ ok: true, message: `timed out for ${minutes || 10} minutes` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WARN ──────────────────────────────────────────────
app.post('/api/action/warn', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const count = addWarning(guildId, userId);
    addInfraction(userId, 'warn', reason || 'dashboard warn');
    addLog('MOD', `${userId} warned (${count}) from dashboard`, 'yellow');
    res.json({ ok: true, warnings: count, message: `warned (${count} total)` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UNBAN ─────────────────────────────────────────────
app.post('/api/action/unban', async (req, res) => {
  const { guildId, userId } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    await guild.members.unban(userId);
    addLog('MOD', `${userId} unbanned from dashboard`, 'green');
    res.json({ ok: true, message: 'user unbanned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SEND MESSAGE ──────────────────────────────────────
app.post('/api/action/send-message', async (req, res) => {
  const { guildId, channelId, message } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    await channel.send(message);
    addLog('DASH', `message sent to #${channel.name} from dashboard`, 'blue');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PURGE ─────────────────────────────────────────────
app.post('/api/action/purge', async (req, res) => {
  const { guildId, channelId, amount } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const deleted = await channel.bulkDelete(Math.min(amount || 10, 100), true);
    addLog('MOD', `${deleted.size} messages purged in #${channel.name} from dashboard`, 'yellow');
    res.json({ ok: true, deleted: deleted.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CLEAR WARNINGS ────────────────────────────────────
app.post('/api/action/clearwarnings', (req, res) => {
  const { guildId, userId } = req.body;
  clearWarnings(guildId, userId);
  addLog('MOD', `warnings cleared for ${userId} from dashboard`, 'green');
  res.json({ ok: true });
});

// ── INFRACTIONS ───────────────────────────────────────
app.get('/api/infractions', (req, res) => res.json(state.infractions));
app.delete('/api/infractions/:id', (req, res) => {
  state.infractions = state.infractions.filter(i => i.id !== parseInt(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/infractions', (req, res) => { state.infractions = []; res.json({ ok: true }); });

// ── LOGS ──────────────────────────────────────────────
app.get('/api/logs', (req, res) => res.json(state.logs));
app.delete('/api/logs', (req, res) => { state.logs = []; res.json({ ok: true }); });

// ── LEADERBOARD ───────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const sorted = Object.entries(state.xpData)
    .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
    .slice(0, 20).map(([id, d]) => ({ id, ...d }));
  res.json(sorted);
});

// ── STATS ─────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json({
    totalInfractions: state.infractions.length,
    totalLogs: state.logs.length,
    totalXPUsers: Object.keys(state.xpData).length,
    totalTickets: state.ticketCount,
    wsPing: client.ws?.ping || 0,
  });
});

// ── FALLBACK ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`🌐 dashboard on port ${PORT}`));
