require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { client, state, addLog, addWarning, clearWarnings, addInfraction, createVerifyToken, completeVerification, saveState } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BOT_TOKEN;
const DISCORD = 'https://discord.com/api/v10';

// ── AUTH ──────────────────────────────────────────────
const USERNAME = process.env.DASH_USER || 'foufou';
const PASSWORD = process.env.DASH_PASS || 'fouedben9911';
const sessions = new Set();

function makeSession() {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  sessions.add(id);
  return id;
}

function isAuth(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([^;]+)/);
  return match && sessions.has(match[1]);
}

app.use(cors({
  origin: ['https://mia69696.github.io', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json());

// ── PUBLIC ROUTES (no auth needed) ───────────────────
app.get('/login', (req, res) => {
  if (isAuth(req)) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === USERNAME && password === PASSWORD) {
    const sid = makeSession();
    res.setHeader('Set-Cookie', `session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'wrong username or password' });
});

app.post('/api/logout', (req, res) => {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([^;]+)/);
  if (match) sessions.delete(match[1]);
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ── AUTH MIDDLEWARE (protects everything below) ───────
app.use((req, res, next) => {
  // verify page and api are public — anyone can access
  if (req.path === '/verify' || req.path.startsWith('/api/verify')) return next();
  if (!isAuth(req)) return res.redirect('/login');
  next();
});

// ── PROTECTED STATIC FILES ────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── DISCORD API HELPER ────────────────────────────────
async function dapi(endpoint) {
  const r = await fetch(DISCORD + endpoint, {
    headers: { Authorization: 'Bot ' + TOKEN, 'Content-Type': 'application/json' }
  });
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
        return { id: g.id, name: g.name, icon: g.icon, owner: g.owner,
          member_count: full.approximate_member_count || 0,
          presence_count: full.approximate_presence_count || 0 };
      } catch { return { id: g.id, name: g.name, icon: g.icon, owner: g.owner, member_count: 0 }; }
    }));
    res.json(detailed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/guilds/:id/members', async (req, res) => {
  try { res.json(await dapi('/guilds/' + req.params.id + '/members?limit=100')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/guilds/:id/channels', async (req, res) => {
  try { res.json(await dapi('/guilds/' + req.params.id + '/channels')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/guilds/:id/roles', async (req, res) => {
  try { res.json(await dapi('/guilds/' + req.params.id + '/roles')); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SETTINGS ──────────────────────────────────────────
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
  saveState();
  res.json({ ok: true });
});

app.post('/api/toggle', (req, res) => {
  const { key, value } = req.body;
  const allowed = ['blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
    'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'invalid key' });
  state[key] = value;
  addLog('DASH', key + ' set to ' + value, value ? 'green' : 'yellow');
  saveState();
  res.json({ ok: true, [key]: state[key] });
});

// ── ACTIONS ───────────────────────────────────────────
app.post('/api/action/ban', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    await guild.members.ban(userId, { reason: reason || 'banned from dashboard' });
    addInfraction(userId, 'ban', reason || 'dashboard ban');
    addLog('MOD', userId + ' banned from dashboard', 'red');
    res.json({ ok: true, message: 'user banned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/kick', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const member = await guild.members.fetch(userId);
    await member.kick(reason || 'kicked from dashboard');
    addInfraction(userId, 'kick', reason || 'dashboard kick');
    addLog('MOD', userId + ' kicked from dashboard', 'red');
    res.json({ ok: true, message: 'user kicked' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/timeout', async (req, res) => {
  const { guildId, userId, minutes, reason } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const member = await guild.members.fetch(userId);
    await member.timeout((minutes || 10) * 60000, reason || 'timeout from dashboard');
    addInfraction(userId, 'timeout', reason || 'dashboard timeout');
    addLog('MOD', userId + ' timed out ' + (minutes||10) + 'min from dashboard', 'yellow');
    res.json({ ok: true, message: 'timed out for ' + (minutes||10) + ' minutes' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/warn', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const count = addWarning(guildId, userId);
    addInfraction(userId, 'warn', reason || 'dashboard warn');
    addLog('MOD', userId + ' warned (' + count + ') from dashboard', 'yellow');
    res.json({ ok: true, warnings: count, message: 'warned (' + count + ' total)' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/unban', async (req, res) => {
  const { guildId, userId } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    await guild.members.unban(userId);
    addLog('MOD', userId + ' unbanned from dashboard', 'green');
    res.json({ ok: true, message: 'user unbanned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/clearwarnings', (req, res) => {
  const { guildId, userId } = req.body;
  clearWarnings(guildId, userId);
  addLog('MOD', 'warnings cleared for ' + userId + ' from dashboard', 'green');
  res.json({ ok: true });
});

app.post('/api/action/send-message', async (req, res) => {
  const { guildId, channelId, message } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    await channel.send(message);
    addLog('DASH', 'message sent to #' + channel.name + ' from dashboard', 'blue');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/purge', async (req, res) => {
  const { guildId, channelId, amount } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const deleted = await channel.bulkDelete(Math.min(amount || 10, 100), true);
    addLog('MOD', deleted.size + ' messages purged in #' + channel.name, 'yellow');
    res.json({ ok: true, deleted: deleted.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── VERIFY SYSTEM ─────────────────────────────────────
// tokens: { token -> { userId, guildId, expires } }
const verifyTokens = {};

// generate a verify link for a user
app.post('/api/verify/create', (req, res) => {
  const { userId, guildId } = req.body;
  if (!userId || !guildId) return res.status(400).json({ error: 'userId and guildId required' });
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  verifyTokens[token] = { userId, guildId, expires: Date.now() + 1000 * 60 * 60 }; // 1hr
  const link = (process.env.RAILWAY_PUBLIC_DOMAIN
    ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN
    : 'http://localhost:' + (process.env.PORT || 3000))
    + '/verify?user=' + userId + '&guild=' + guildId + '&token=' + token;
  res.json({ ok: true, link });
});

// called by verify page after captcha — gives user the role
app.post('/api/verify', async (req, res) => {
  const { userId, guildId, token } = req.body;
  const entry = verifyTokens[token];
  if (!entry) return res.status(400).json({ error: 'invalid or expired link — ask for a new one' });
  if (entry.userId !== userId || entry.guildId !== guildId) return res.status(400).json({ error: 'token mismatch' });
  if (Date.now() > entry.expires) {
    delete verifyTokens[token];
    return res.status(400).json({ error: 'link expired — ask for a new one' });
  }
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return res.status(404).json({ error: 'user not found in server' });

    // find or create Verified role
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === 'verified');
    if (!role) {
      role = await guild.roles.create({ name: 'Verified', color: 0x00e87a, reason: 'ahh bot auto-created verify role' });
    }
    await member.roles.add(role);
    delete verifyTokens[token];
    addLog('VERIFY', member.user.username + ' verified in ' + guild.name, 'green');
    res.json({ ok: true, message: 'role assigned!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// get verify settings
app.get('/api/verify/settings', (req, res) => {
  res.json({
    verifyEnabled: state.verifyEnabled || false,
    verifyChannelId: state.verifyChannelId || null,
    verifyRoleName: state.verifyRoleName || 'Verified',
  });
});

// save verify settings
app.post('/api/verify/settings', (req, res) => {
  const { verifyEnabled, verifyChannelId, verifyRoleName } = req.body;
  if (verifyEnabled !== undefined) state.verifyEnabled = verifyEnabled;
  if (verifyChannelId !== undefined) state.verifyChannelId = verifyChannelId;
  if (verifyRoleName !== undefined) state.verifyRoleName = verifyRoleName;
  res.json({ ok: true });
});

// ── DATA ──────────────────────────────────────────────
app.get('/api/infractions', (req, res) => res.json(state.infractions));
app.delete('/api/infractions/:id', (req, res) => {
  state.infractions = state.infractions.filter(i => i.id !== parseInt(req.params.id));
  res.json({ ok: true });
});
app.delete('/api/infractions', (req, res) => { state.infractions = []; res.json({ ok: true }); });
app.get('/api/logs', (req, res) => res.json(state.logs));
app.delete('/api/logs', (req, res) => { state.logs = []; res.json({ ok: true }); });
app.get('/api/leaderboard', (req, res) => {
  const sorted = Object.entries(state.xpData)
    .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
    .slice(0, 20).map(([id, d]) => ({ id, ...d }));
  res.json(sorted);
});
app.get('/api/stats', (req, res) => {
  res.json({
    totalInfractions: state.infractions.length,
    totalLogs: state.logs.length,
    totalXPUsers: Object.keys(state.xpData).length,
    totalTickets: state.ticketCount,
    wsPing: client.ws?.ping || 0,
  });
});

// ── VERIFICATION ─────────────────────────────────────

// serve verify page publicly (no login needed — users visit this)
app.get('/verify', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

// generate a verify link for a specific user (dashboard calls this)
app.post('/api/verify/generate', (req, res) => {
  const { userId, guildId } = req.body;
  if (!userId || !guildId) return res.status(400).json({ error: 'userId and guildId required' });
  const token = createVerifyToken(userId, guildId);
  const link = 'https://mia69696.github.io/verify/?token=' + token;
  res.json({ ok: true, token, link });
});

// called when user completes captcha on verify page
app.post('/api/verify/complete', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });
  const result = await completeVerification(token);
  if (!result.ok) {
    addLog('VERIFY', 'verification failed: ' + result.error, 'red');
  }
  res.json(result);
});

// debug — check if a token is valid (so user can see why it failed)
app.get('/api/verify/check/:token', (req, res) => {
  const data = state.pendingVerifications[req.params.token];
  if (!data) return res.json({ valid: false, reason: 'token not found or already used' });
  if (Date.now() > data.expires) return res.json({ valid: false, reason: 'token expired' });
  res.json({
    valid: true,
    userId: data.userId,
    guildId: data.guildId,
    roleId: data.roleId || state.verifiedRoleId || null,
    roleConfigured: !!(data.roleId || state.verifiedRoleId),
    expiresIn: Math.floor((data.expires - Date.now()) / 1000) + 's',
  });
});

// get/save verification settings
app.get('/api/verify/settings', (req, res) => {
  res.json({
    verificationEnabled: state.verificationEnabled,
    verifiedRoleId: state.verifiedRoleId,
    verificationChannelId: state.verificationChannelId,
  });
});

app.post('/api/verify/settings', (req, res) => {
  const { verificationEnabled, verifiedRoleId, verificationChannelId } = req.body;
  if (verificationEnabled !== undefined) state.verificationEnabled = verificationEnabled;
  if (verifiedRoleId !== undefined) state.verifiedRoleId = verifiedRoleId;
  if (verificationChannelId !== undefined) state.verificationChannelId = verificationChannelId;
  addLog('DASH', 'verification settings updated', 'blue');
  saveState();
  res.json({ ok: true });
});

// send verify embed to a channel (bot posts the button message)
app.post('/api/verify/send-panel', async (req, res) => {
  const { guildId, channelId } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const { EmbedBuilder } = require('discord.js');
    const siteUrl = 'https://mia69696.github.io/verify/';
    const embed = new EmbedBuilder()
      .setColor(0x00e87a)
      .setTitle('✅  verify yourself')
      .setDescription(
        '> click the button below to verify and gain access to all channels.\n\n' +
        '```\n1. Click the link\n2. Solve the captcha\n3. Get the @verified role\n```'
      )
      .addFields(
        { name: '⚡ instant', value: 'role assigned immediately', inline: true },
        { name: '🔒 secure', value: 'captcha protected', inline: true },
        { name: '✅ required', value: 'to access server', inline: true },
      )
      .setFooter({ text: 'ahh bot · verification system' })
      .setTimestamp();
    await channel.send({
      embeds: [embed],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 5,
          label: '✅  verify me',
          url: 'https://mia69696.github.io/verify/?guild=' + guildId,
        }]
      }]
    });
    addLog('VERIFY', 'verification panel sent to #' + channel.name, 'green');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// when user clicks button in Discord — generate their token and redirect to verify page
app.get('/verify-start', (req, res) => {
  // This is a placeholder — in production you'd need Discord OAuth to get the userId
  // For now redirect to the verify page with the guildId
  const { guild } = req.query;
  res.redirect('https://mia69696.github.io/verify/?guild=' + (guild || ''));
});

// ── FALLBACK ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log('dashboard on port ' + PORT));
