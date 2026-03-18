require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials,
  SlashCommandBuilder, Routes, EmbedBuilder,
  PermissionFlagsBits, REST, ActivityType
} = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;

// ── SHARED STATE ─────────────────────────────────────
const state = {
  // automod
  blockInvites: true,
  blockSpam: true,
  badWordsFilter: true,
  blockMassMentions: true,
  capsFilter: false,
  blockLinks: false,
  // features
  welcomeEnabled: true,
  goodbyeEnabled: true,
  levelingEnabled: true,
  ticketsEnabled: true,
  // config
  welcomeMessage: 'welcome to the server, {user}! you\'re member #{count}.',
  goodbyeMessage: '{user} has left the server.',
  levelUpMessage: 'gg {user}, you hit level {level}!',
  welcomeChannelId: null,
  logChannelId: null,
  autobanThreshold: 3,
  prefix: '!',
  muteMinutes: 10,
  badWordsList: ['badword1', 'badword2'],
  // data
  xpData: {},
  warnings: {},
  infractions: [],
  infId: 1,
  logs: [],
  tickets: {},
  ticketCount: 0,
};

// ── HELPERS ───────────────────────────────────────────
function addLog(type, msg, color = 'blue') {
  state.logs.unshift({ type, msg, color, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
  if (state.logs.length > 200) state.logs.pop();
}

function getXP(userId) {
  if (!state.xpData[userId]) state.xpData[userId] = { xp: 0, level: 1 };
  return state.xpData[userId];
}

function addXP(userId, amount) {
  const d = getXP(userId);
  d.xp += amount;
  const needed = d.level * 100;
  if (d.xp >= needed) { d.xp -= needed; d.level++; return true; }
  return false;
}

function getWarnings(guildId, userId) {
  if (!state.warnings[guildId]) state.warnings[guildId] = {};
  return state.warnings[guildId][userId] || 0;
}

function addWarning(guildId, userId) {
  if (!state.warnings[guildId]) state.warnings[guildId] = {};
  state.warnings[guildId][userId] = (state.warnings[guildId][userId] || 0) + 1;
  return state.warnings[guildId][userId];
}

function clearWarnings(guildId, userId) {
  if (state.warnings[guildId]) state.warnings[guildId][userId] = 0;
}

function makeEmbed(color, title, desc) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp();
}

function addInfraction(user, act, reason) {
  state.infractions.unshift({ id: state.infId++, user, act, reason, time: new Date().toLocaleTimeString() });
  if (state.infractions.length > 500) state.infractions.pop();
}

const spamTracker = {};
const xpCooldown = new Set();

function isSpam(userId) {
  const now = Date.now();
  if (!spamTracker[userId]) spamTracker[userId] = [];
  spamTracker[userId] = spamTracker[userId].filter(t => now - t < 5000);
  spamTracker[userId].push(now);
  return spamTracker[userId].length >= 5;
}

const INVITE_RE = /(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9-]+/gi;
const LINK_RE = /https?:\/\/[^\s]+/gi;

// ── CLIENT ────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
});

// ── COMMANDS ─────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addUserOption(o => o.setName('user').setDescription('User to ban').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .addUserOption(o => o.setName('user').setDescription('User to kick').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .addUserOption(o => o.setName('user').setDescription('User to warn').setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder().setName('mute').setDescription('Timeout a member')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o => o.setName('minutes').setDescription('Minutes (default 10)'))
    .addStringOption(o => o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder().setName('warnings').setDescription('Check warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder().setName('clearwarnings').setDescription('Clear warnings for a user')
    .addUserOption(o => o.setName('user').setDescription('User').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder().setName('purge').setDescription('Delete messages in bulk')
    .addIntegerOption(o => o.setName('amount').setDescription('Amount (1-100)').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder().setName('rank').setDescription('Check your XP rank')
    .addUserOption(o => o.setName('user').setDescription('User (optional)')),

  new SlashCommandBuilder().setName('leaderboard').setDescription('Top members by XP'),

  new SlashCommandBuilder().setName('serverinfo').setDescription('Server information'),

  new SlashCommandBuilder().setName('userinfo').setDescription('User information')
    .addUserOption(o => o.setName('user').setDescription('User (optional)')),

  new SlashCommandBuilder().setName('ticket').setDescription('Open a support ticket'),

  new SlashCommandBuilder().setName('closeticket').setDescription('Close this ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder().setName('say').setDescription('Make the bot say something')
    .addStringOption(o => o.setName('message').setDescription('What to say').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder().setName('ping').setDescription('Check bot ping'),

  new SlashCommandBuilder().setName('help').setDescription('All commands'),
].map(c => c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    console.log(`✅ commands registered in ${guildId}`);
  } catch (e) { console.error('register error:', e.message); }
}

// ── READY ─────────────────────────────────────────────
client.once('ready', () => {
  console.log(`🤖 bot online: ${client.user.tag}`);
  client.user.setActivity('your server', { type: ActivityType.Watching });
  client.guilds.cache.forEach(g => registerCommands(g.id));
  addLog('START', `bot online as ${client.user.tag}`, 'green');
});

client.on('guildCreate', g => {
  registerCommands(g.id);
  addLog('JOIN', `bot joined server: ${g.name}`, 'green');
});

// ── WELCOME / GOODBYE ─────────────────────────────────
client.on('guildMemberAdd', async member => {
  if (!state.welcomeEnabled) return;
  const ch = state.welcomeChannelId
    ? member.guild.channels.cache.get(state.welcomeChannelId)
    : member.guild.systemChannel;
  if (!ch) return;
  const msg = state.welcomeMessage
    .replace(/{user}/g, `<@${member.id}>`)
    .replace(/{count}/g, member.guild.memberCount)
    .replace(/{server}/g, member.guild.name);
  ch.send({ embeds: [makeEmbed(0x111111, '👋 welcome!', msg).setThumbnail(member.user.displayAvatarURL())] }).catch(() => {});
  addLog('JOIN', `${member.user.username} joined ${member.guild.name}`, 'green');
});

client.on('guildMemberRemove', async member => {
  if (!state.goodbyeEnabled) return;
  const ch = state.welcomeChannelId
    ? member.guild.channels.cache.get(state.welcomeChannelId)
    : member.guild.systemChannel;
  if (!ch) return;
  const msg = state.goodbyeMessage
    .replace(/{user}/g, member.user.username)
    .replace(/{server}/g, member.guild.name);
  ch.send({ embeds: [makeEmbed(0x222222, '👋 goodbye', msg)] }).catch(() => {});
  addLog('LEAVE', `${member.user.username} left ${member.guild.name}`, 'yellow');
});

// ── AUTO MOD + XP ─────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);
  const isMod = message.member?.permissions.has(PermissionFlagsBits.ModerateMembers);

  if (!isAdmin && !isMod) {
    const content = message.content;

    // invite links
    if (state.blockInvites && INVITE_RE.test(content)) {
      await message.delete().catch(() => {});
      const w = addWarning(message.guild.id, message.author.id);
      const reply = await message.channel.send({ embeds: [makeEmbed(0xff0000, '🚫 invite blocked', `<@${message.author.id}> no invite links here. warning **${w}/${state.autobanThreshold}**.`)] });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      addLog('AUTOMOD', `${message.author.username} posted invite link (warn ${w})`, 'red');
      if (w >= state.autobanThreshold) { message.member.ban({ reason: 'too many automod violations' }).catch(() => {}); addLog('MOD', `${message.author.username} auto-banned`, 'red'); }
      return;
    }

    // external links
    if (state.blockLinks && LINK_RE.test(content)) {
      await message.delete().catch(() => {});
      const reply = await message.channel.send({ embeds: [makeEmbed(0xff0000, '🚫 link blocked', `<@${message.author.id}> links are not allowed here.`)] });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      addLog('AUTOMOD', `${message.author.username} posted a link`, 'red');
      return;
    }

    // bad words
    if (state.badWordsFilter && state.badWordsList.some(w => content.toLowerCase().includes(w.toLowerCase()))) {
      await message.delete().catch(() => {});
      const w = addWarning(message.guild.id, message.author.id);
      const reply = await message.channel.send({ embeds: [makeEmbed(0xff0000, '🚫 message removed', `<@${message.author.id}> watch your language. warning **${w}/${state.autobanThreshold}**.`)] });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      addLog('AUTOMOD', `${message.author.username} used a bad word (warn ${w})`, 'red');
      if (w >= state.autobanThreshold) { message.member.ban({ reason: 'too many automod violations' }).catch(() => {}); addLog('MOD', `${message.author.username} auto-banned`, 'red'); }
      return;
    }

    // spam
    if (state.blockSpam && isSpam(message.author.id)) {
      await message.delete().catch(() => {});
      await message.member.timeout(state.muteMinutes * 60000, 'spamming').catch(() => {});
      const reply = await message.channel.send({ embeds: [makeEmbed(0xff8800, '⚠️ spam detected', `<@${message.author.id}> timed out for ${state.muteMinutes} minutes for spamming.`)] });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      addLog('AUTOMOD', `${message.author.username} timed out for spamming`, 'yellow');
      return;
    }

    // mass mentions
    if (state.blockMassMentions && message.mentions.users.size >= 3) {
      await message.delete().catch(() => {});
      const w = addWarning(message.guild.id, message.author.id);
      const reply = await message.channel.send({ embeds: [makeEmbed(0xff8800, '⚠️ mass mention', `<@${message.author.id}> no mass mentions. warning **${w}/${state.autobanThreshold}**.`)] });
      setTimeout(() => reply.delete().catch(() => {}), 5000);
      addLog('AUTOMOD', `${message.author.username} mass mentioned ${message.mentions.users.size} users`, 'yellow');
      return;
    }

    // caps
    if (state.capsFilter && content.length > 8) {
      const letters = content.replace(/[^a-zA-Z]/g, '');
      if (letters.length > 5 && letters.split('').filter(c => c === c.toUpperCase()).length / letters.length > 0.7) {
        await message.delete().catch(() => {});
        const reply = await message.channel.send({ embeds: [makeEmbed(0xff8800, '⚠️ caps', `<@${message.author.id}> stop yelling.`)] });
        setTimeout(() => reply.delete().catch(() => {}), 4000);
        addLog('AUTOMOD', `${message.author.username} used excessive caps`, 'yellow');
        return;
      }
    }
  }

  // XP
  if (state.levelingEnabled && !xpCooldown.has(message.author.id)) {
    xpCooldown.add(message.author.id);
    setTimeout(() => xpCooldown.delete(message.author.id), 60000);
    const leveled = addXP(message.author.id, Math.floor(Math.random() * 10) + 5);
    if (leveled) {
      const d = getXP(message.author.id);
      const lvlMsg = state.levelUpMessage.replace(/{user}/g, `<@${message.author.id}>`).replace(/{level}/g, d.level);
      const reply = await message.channel.send({ embeds: [makeEmbed(0x00ff88, '🎉 level up!', lvlMsg)] });
      setTimeout(() => reply.delete().catch(() => {}), 10000);
      addLog('LEVEL', `${message.author.username} reached level ${d.level}`, 'green');
    }
  }
});

// ── SLASH COMMANDS ────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  try {
    if (cmd === 'ban') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'no reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.ban({ reason });
      addInfraction(user.username, 'ban', reason);
      addLog('MOD', `${user.username} was banned — ${reason}`, 'red');
      await interaction.reply({ embeds: [makeEmbed(0xff0000, '🔨 banned', `**${user.username}** was banned.\n**reason:** ${reason}`)] });
    }

    else if (cmd === 'kick') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'no reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      addInfraction(user.username, 'kick', reason);
      addLog('MOD', `${user.username} was kicked — ${reason}`, 'red');
      await interaction.reply({ embeds: [makeEmbed(0xff4400, '👟 kicked', `**${user.username}** was kicked.\n**reason:** ${reason}`)] });
    }

    else if (cmd === 'warn') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'no reason';
      const count = addWarning(interaction.guild.id, user.id);
      addInfraction(user.username, 'warn', reason);
      addLog('MOD', `${user.username} warned (${count}) — ${reason}`, 'yellow');
      await interaction.reply({ embeds: [makeEmbed(0xffaa00, '⚠️ warned', `**${user.username}** warned.\n**reason:** ${reason}\n**warnings:** ${count}/${state.autobanThreshold}`)] });
      if (count >= state.autobanThreshold) {
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (member) { await member.ban({ reason: 'reached warning limit' }); await interaction.followUp({ embeds: [makeEmbed(0xff0000, '🔨 auto-banned', `**${user.username}** reached ${state.autobanThreshold} warnings.`)] }); }
      }
    }

    else if (cmd === 'mute') {
      const user = interaction.options.getUser('user');
      const mins = interaction.options.getInteger('minutes') || state.muteMinutes;
      const reason = interaction.options.getString('reason') || 'no reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(mins * 60000, reason);
      addInfraction(user.username, 'timeout', reason);
      addLog('MOD', `${user.username} timed out ${mins}min — ${reason}`, 'yellow');
      await interaction.reply({ embeds: [makeEmbed(0x8800ff, '🔇 muted', `**${user.username}** timed out for **${mins} min**.\n**reason:** ${reason}`)] });
    }

    else if (cmd === 'unmute') {
      const user = interaction.options.getUser('user');
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(null);
      addLog('MOD', `${user.username} unmuted`, 'green');
      await interaction.reply({ embeds: [makeEmbed(0x00ff88, '🔊 unmuted', `**${user.username}**'s timeout was removed.`)] });
    }

    else if (cmd === 'warnings') {
      const user = interaction.options.getUser('user');
      const count = getWarnings(interaction.guild.id, user.id);
      await interaction.reply({ embeds: [makeEmbed(0xffaa00, '⚠️ warnings', `**${user.username}** has **${count}/${state.autobanThreshold}** warnings.`)] });
    }

    else if (cmd === 'clearwarnings') {
      const user = interaction.options.getUser('user');
      clearWarnings(interaction.guild.id, user.id);
      addLog('MOD', `warnings cleared for ${user.username}`, 'green');
      await interaction.reply({ embeds: [makeEmbed(0x00ff88, '✅ cleared', `Warnings cleared for **${user.username}**.`)] });
    }

    else if (cmd === 'purge') {
      const amount = Math.min(100, Math.max(1, interaction.options.getInteger('amount')));
      const deleted = await interaction.channel.bulkDelete(amount, true);
      addLog('MOD', `${deleted.size} messages purged in #${interaction.channel.name}`, 'yellow');
      await interaction.reply({ embeds: [makeEmbed(0x00ff88, '🗑️ purged', `Deleted **${deleted.size}** messages.`)], ephemeral: true });
    }

    else if (cmd === 'rank') {
      const user = interaction.options.getUser('user') || interaction.user;
      const d = getXP(user.id);
      const needed = d.level * 100;
      const filled = Math.floor((d.xp / needed) * 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      await interaction.reply({ embeds: [makeEmbed(0x111111, `📊 ${user.username}'s rank`, `**level:** ${d.level}\n**xp:** ${d.xp}/${needed}\n\`${bar}\``).setThumbnail(user.displayAvatarURL())] });
    }

    else if (cmd === 'leaderboard') {
      const sorted = Object.entries(state.xpData).sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp).slice(0, 10);
      const medals = ['🥇', '🥈', '🥉'];
      const desc = sorted.length ? sorted.map(([id, d], i) => `${medals[i] || `**${i + 1}.**`} <@${id}> — level **${d.level}** (${d.xp} xp)`).join('\n') : 'no xp yet — start chatting!';
      await interaction.reply({ embeds: [makeEmbed(0x111111, '🏆 leaderboard', desc)] });
    }

    else if (cmd === 'serverinfo') {
      const g = interaction.guild;
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x111111).setTitle(g.name).setThumbnail(g.iconURL())
        .addFields(
          { name: 'owner', value: `<@${g.ownerId}>`, inline: true },
          { name: 'members', value: `${g.memberCount}`, inline: true },
          { name: 'created', value: `<t:${Math.floor(g.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'channels', value: `${g.channels.cache.size}`, inline: true },
          { name: 'roles', value: `${g.roles.cache.size}`, inline: true },
          { name: 'id', value: g.id, inline: true },
        ).setTimestamp()] });
    }

    else if (cmd === 'userinfo') {
      const user = interaction.options.getUser('user') || interaction.user;
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      const d = getXP(user.id);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x111111).setTitle(user.username).setThumbnail(user.displayAvatarURL())
        .addFields(
          { name: 'id', value: user.id, inline: true },
          { name: 'joined', value: member ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : '—', inline: true },
          { name: 'created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
          { name: 'level', value: `${d.level}`, inline: true },
          { name: 'xp', value: `${d.xp}`, inline: true },
          { name: 'warnings', value: `${getWarnings(interaction.guild.id, user.id)}`, inline: true },
        ).setTimestamp()] });
    }

    else if (cmd === 'ticket') {
      if (!state.ticketsEnabled) return interaction.reply({ content: 'tickets are disabled.', ephemeral: true });
      state.ticketCount++;
      const ticketNum = String(state.ticketCount).padStart(4, '0');
      const channel = await interaction.guild.channels.create({
        name: `ticket-${ticketNum}`,
        permissionOverwrites: [
          { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
      state.tickets[channel.id] = { userId: interaction.user.id, ticketNum, opened: new Date().toISOString() };
      await channel.send({ embeds: [makeEmbed(0x111111, `🎫 ticket #${ticketNum}`, `hey <@${interaction.user.id}>, staff will be with you shortly.\nuse \`/closeticket\` to close this.`)] });
      await interaction.reply({ content: `ticket opened: <#${channel.id}>`, ephemeral: true });
      addLog('TICKET', `${interaction.user.username} opened ticket #${ticketNum}`, 'cyan');
    }

    else if (cmd === 'closeticket') {
      const ticket = state.tickets[interaction.channel.id];
      if (!ticket) return interaction.reply({ content: 'this is not a ticket channel.', ephemeral: true });
      await interaction.reply({ embeds: [makeEmbed(0x111111, '🔒 ticket closed', 'this ticket will be deleted in 5 seconds.')] });
      addLog('TICKET', `ticket #${ticket.ticketNum} closed`, 'yellow');
      delete state.tickets[interaction.channel.id];
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
    }

    else if (cmd === 'say') {
      const msg = interaction.options.getString('message');
      await interaction.reply({ content: '✅ sent', ephemeral: true });
      await interaction.channel.send(msg);
      addLog('CMD', `${interaction.user.username} used /say: ${msg}`, 'blue');
    }

    else if (cmd === 'ping') {
      const ping = client.ws.ping;
      await interaction.reply({ embeds: [makeEmbed(0x111111, '🏓 pong!', `websocket ping: **${ping}ms**`)] });
    }

    else if (cmd === 'help') {
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x111111).setTitle('📖 ahh — all commands')
        .addFields(
          { name: '🔨 moderation', value: '`/ban` `/kick` `/warn` `/mute` `/unmute`\n`/warnings` `/clearwarnings` `/purge`' },
          { name: '📊 leveling', value: '`/rank` `/leaderboard`' },
          { name: '🎫 tickets', value: '`/ticket` `/closeticket`' },
          { name: '🛠️ utility', value: '`/say` `/ping` `/serverinfo` `/userinfo` `/help`' },
          { name: '🤖 auto mod', value: 'invite links, spam, bad words, mass mentions, caps — all automatic' },
        ).setFooter({ text: 'ahh bot' }).setTimestamp()], ephemeral: true });
    }

  } catch (e) {
    console.error('command error:', e.message);
    const reply = { content: `error: ${e.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.login(TOKEN).catch(e => console.error('❌ login failed:', e.message));

module.exports = { client, state, addLog, addWarning, getWarnings, clearWarnings, addInfraction };
