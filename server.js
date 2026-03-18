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

// ── CORS — allow everything (needed for GitHub Pages) ─
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

// ── PUBLIC ROUTES (no login needed) ──────────────────

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

// ── VERIFY ROUTES (fully public — no login) ───────────

app.get('/verify', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.post('/api/verify/generate', (req, res) => {
  const { userId, guildId } = req.body;
  if (!userId || !guildId) return res.status(400).json({ ok: false, error: 'userId and guildId required' });
  const token = createVerifyToken(userId, guildId);
  const link = 'https://mia69696.github.io/verify/?token=' + token;
  res.json({ ok: true, token, link });
});

app.post('/api/verify/complete', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'token required' });
  const result = await completeVerification(token);
  if (!result.ok) addLog('VERIFY', 'failed: ' + result.error, 'red');
  res.json(result);
});

app.get('/api/verify/settings', (req, res) => {
  res.json({
    verificationEnabled: state.verificationEnabled,
    verifiedRoleId: state.verifiedRoleId,
    unverifiedRoleId: state.unverifiedRoleId,
    verificationChannelId: state.verificationChannelId,
    verifyMessageId: state.verifyMessageId,
    verifyEmoji: state.verifyEmoji,
  });
});

app.post('/api/verify/settings', (req, res) => {
  const { verificationEnabled, verifiedRoleId, unverifiedRoleId, verificationChannelId, verifyEmoji } = req.body;
  if (verificationEnabled !== undefined) state.verificationEnabled = verificationEnabled;
  if (verifiedRoleId !== undefined) state.verifiedRoleId = verifiedRoleId;
  if (unverifiedRoleId !== undefined) state.unverifiedRoleId = unverifiedRoleId;
  if (verificationChannelId !== undefined) state.verificationChannelId = verificationChannelId;
  if (verifyEmoji !== undefined) state.verifyEmoji = verifyEmoji;
  saveState();
  addLog('DASH', 'verification settings saved', 'blue');
  res.json({ ok: true });
});

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

app.get('/verify-start', (req, res) => {
  const { guild } = req.query;
  res.redirect('https://mia69696.github.io/verify/?guild=' + (guild || ''));
});

// ── AUTH MIDDLEWARE — protects everything below ───────
app.use((req, res, next) => {
  if (!isAuth(req)) return res.redirect('/login');
  next();
});

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
        return { id: g.id, name: g.name, icon: g.icon, owner: g.owner, member_count: full.approximate_member_count || 0, presence_count: full.approximate_presence_count || 0 };
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
    logChannels: state.logChannels,
  });
});

// get/save log channels specifically
app.get('/api/logchannels', (req, res) => res.json(state.logChannels));

app.post('/api/logchannels', (req, res) => {
  const keys = ['deletedMessages','editedMessages','joinLeave','modActions','commands','images','voiceActivity','roleChanges'];
  keys.forEach(k => { if (req.body[k] !== undefined) state.logChannels[k] = req.body[k] || null; });
  saveState();
  addLog('DASH', 'log channels updated', 'blue');
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const allowed = ['blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
    'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled','welcomeMessage','goodbyeMessage',
    'levelUpMessage','welcomeChannelId','logChannelId','autobanThreshold','prefix','muteMinutes','badWordsList','logChannels'];
  allowed.forEach(k => { if (req.body[k] !== undefined) state[k] = req.body[k]; });
  saveState();
  addLog('DASH', 'settings updated', 'blue');
  res.json({ ok: true });
});

app.post('/api/toggle', (req, res) => {
  const { key, value } = req.body;
  const allowed = ['blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
    'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled','verificationEnabled'];
  if (!allowed.includes(key)) return res.status(400).json({ error: 'invalid key' });
  state[key] = value;
  saveState();
  addLog('DASH', key + ' → ' + value, value ? 'green' : 'yellow');
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
    saveState();
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
    saveState();
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
    addLog('MOD', userId + ' timed out from dashboard', 'yellow');
    saveState();
    res.json({ ok: true, message: 'timed out' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/warn', async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const count = addWarning(guildId, userId);
    addInfraction(userId, 'warn', reason || 'dashboard warn');
    addLog('MOD', userId + ' warned (' + count + ')', 'yellow');
    saveState();
    res.json({ ok: true, warnings: count, message: 'warned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/unban', async (req, res) => {
  const { guildId, userId } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    await guild.members.unban(userId);
    addLog('MOD', userId + ' unbanned', 'green');
    res.json({ ok: true, message: 'unbanned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action/clearwarnings', (req, res) => {
  const { guildId, userId } = req.body;
  clearWarnings(guildId, userId);
  addLog('MOD', 'warnings cleared for ' + userId, 'green');
  saveState();
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
    addLog('DASH', 'message sent to #' + channel.name, 'blue');
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
    addLog('MOD', deleted.size + ' messages purged', 'yellow');
    res.json({ ok: true, deleted: deleted.size });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify/send-panel', async (req, res) => {
  const { guildId, channelId } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });
    const { EmbedBuilder } = require('discord.js');
    const emoji = state.verifyEmoji || '✅';

    const embed = new EmbedBuilder()
      .setColor(0x00e87a)
      .setTitle(emoji + '  verify to get access')
      .setDescription(
        '> react with ' + emoji + ' below to instantly get the verified role and access all channels.' +
        '\n\n' +
        '**how it works:**\n' +
        '1. React with ' + emoji + ' to this message\n' +
        '2. Bot gives you the **@verified** role\n' +
        '3. Your **@unverified** role gets removed\n' +
        '4. You now have full access!'
      )
      .addFields(
        { name: '⚡ instant', value: 'role assigned in seconds', inline: true },
        { name: '🔒 automatic', value: 'no forms needed', inline: true },
        { name: '✅ required', value: 'to access channels', inline: true },
      )
      .setFooter({ text: 'fa11en · just react to verify' })
      .setTimestamp();

    const msg = await channel.send({ embeds: [embed] });

    // add the reaction so users know what to click
    await msg.react(emoji);

    // save the message id so the bot knows which message to watch
    state.verifyMessageId = msg.id;
    saveState();

    addLog('VERIFY', 'reaction verify panel posted in #' + channel.name, 'green');
    res.json({ ok: true, messageId: msg.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DATA ──────────────────────────────────────────────
app.get('/api/infractions', (req, res) => res.json(state.infractions));
app.delete('/api/infractions/:id', (req, res) => {
  state.infractions = state.infractions.filter(i => i.id !== parseInt(req.params.id));
  saveState(); res.json({ ok: true });
});
app.delete('/api/infractions', (req, res) => { state.infractions = []; saveState(); res.json({ ok: true }); });
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

// ── TEMP VOICE API ───────────────────────────────────

app.get('/api/tempvoice/settings', (req, res) => {
  res.json({
    tempVoiceEnabled: state.tempVoiceEnabled,
    tempVoiceCategoryId: state.tempVoiceCategoryId,
    tempVoiceCreatorId: state.tempVoiceCreatorId,
    activeChannels: Object.entries(state.tempVoiceChannels).map(([id, d]) => ({ id, ...d })),
  });
});

app.post('/api/tempvoice/settings', (req, res) => {
  const { tempVoiceEnabled, tempVoiceCategoryId, tempVoiceCreatorId } = req.body;
  if (tempVoiceEnabled !== undefined) state.tempVoiceEnabled = tempVoiceEnabled;
  if (tempVoiceCategoryId !== undefined) state.tempVoiceCategoryId = tempVoiceCategoryId || null;
  if (tempVoiceCreatorId !== undefined) state.tempVoiceCreatorId = tempVoiceCreatorId || null;
  saveState();
  addLog('DASH', 'temp voice settings saved', 'blue');
  res.json({ ok: true });
});

// setup: create the "join to create" channel automatically
app.post('/api/tempvoice/setup', async (req, res) => {
  const { guildId } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });

    // create category
    const category = await guild.channels.create({
      name: '🔊 Temp Voice',
      type: 4, // category
    });

    // create join-to-create channel
    const creator = await guild.channels.create({
      name: '➕ Join to Create',
      type: 2, // voice
      parent: category.id,
    });

    state.tempVoiceCategoryId = category.id;
    state.tempVoiceCreatorId = creator.id;
    state.tempVoiceEnabled = true;
    saveState();
    addLog('DASH', 'temp voice setup complete in ' + guild.name, 'green');
    res.json({ ok: true, categoryId: category.id, creatorId: creator.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// control a specific temp voice channel from dashboard
app.post('/api/tempvoice/control', async (req, res) => {
  const { guildId, channelId, action, value } = req.body;
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'bot not in that server' });
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'channel not found' });

    if (action === 'rename') {
      await channel.setName(value);
      if (state.tempVoiceChannels[channelId]) state.tempVoiceChannels[channelId].name = value;
    } else if (action === 'limit') {
      await channel.setUserLimit(parseInt(value) || 0);
      if (state.tempVoiceChannels[channelId]) state.tempVoiceChannels[channelId].limit = parseInt(value) || 0;
    } else if (action === 'lock') {
      await channel.permissionOverwrites.edit(guild.id, { Connect: false });
    } else if (action === 'unlock') {
      await channel.permissionOverwrites.edit(guild.id, { Connect: true });
    } else if (action === 'delete') {
      delete state.tempVoiceChannels[channelId];
      await channel.delete('deleted from dashboard');
    } else if (action === 'kick') {
      const member = guild.members.cache.get(value);
      if (member?.voice?.channelId === channelId) await member.voice.disconnect();
    }

    addLog('VOICE', 'temp vc ' + action + ' on #' + channel.name + ' from dashboard', 'cyan');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FALLBACK ──────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log('fa11en dashboard on port ' + PORT));
