require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
  // detailed log channels (each type can go to a different channel)
  logChannels: {
    deletedMessages: null,
    editedMessages: null,
    joinLeave: null,
    modActions: null,
    commands: null,
    images: null,
    voiceActivity: null,
    roleChanges: null,
  },
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
  // temp voice
  tempVoiceEnabled: false,
  tempVoiceCategoryId: null,
  tempVoiceCreatorId: null,   // the "join to create" channel id
  tempVoiceChannels: {},      // channelId -> { ownerId, guildId, name, limit }
  // verification
  verificationEnabled: false,
  verifiedRoleId: null,
  unverifiedRoleId: null,
  verificationChannelId: null,
  verifyMessageId: null,  // the message users react to
  verifyEmoji: '✅',      // emoji to react with
  pendingVerifications: {},
};

// ── PERSISTENCE ──────────────────────────────────────
const SAVE_FILE = path.join(__dirname, 'data.json');

// keys that should be saved to disk
const PERSIST_KEYS = [
  'blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
  'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled',
  'welcomeMessage','goodbyeMessage','levelUpMessage',
  'welcomeChannelId','logChannelId','autobanThreshold','prefix','muteMinutes','badWordsList',
  'verificationEnabled','verifiedRoleId','unverifiedRoleId','verificationChannelId','verifyMessageId','verifyEmoji','logChannels',
  'tempVoiceEnabled','tempVoiceCategoryId','tempVoiceCreatorId',
  'xpData','warnings','infractions','infId','ticketCount',
];

function saveState() {
  try {
    const toSave = {};
    PERSIST_KEYS.forEach(k => { toSave[k] = state[k]; });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(toSave, null, 2));
  } catch(e) { console.error('save error:', e.message); }
}

function loadState() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
    Object.keys(saved).forEach(k => {
      if (PERSIST_KEYS.includes(k)) state[k] = saved[k];
    });
    console.log('✅ state loaded from disk');
  } catch(e) { console.error('load error:', e.message); }
}

// load saved state immediately
loadState();

// auto-save every 30 seconds
setInterval(saveState, 30000);

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
  const accountAge = `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`;
  const joinNumber = member.guild.memberCount;

  // animated-style welcome with dividers and rich layout
  const welcomeEmbed = new EmbedBuilder()
    .setColor(0x00e87a)
    .setAuthor({
      name: `✦ ${member.guild.name} ✦`,
      iconURL: member.guild.iconURL({ dynamic: true }) || undefined,
    })
    .setTitle(`welcome, ${member.user.username}! 🎉`)
    .setDescription(
      `> ${msg}\n\n` +
      `\`\`\`\nYou are member #${joinNumber} — glad you're here.\n\`\`\``
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 512 }))
    .addFields(
      { name: '⸻ 👤 user', value: `<@${member.id}>`, inline: true },
      { name: '⸻ 🔢 member #', value: `**${joinNumber}**`, inline: true },
      { name: '⸻ 📅 account age', value: accountAge, inline: true },
      { name: '⸻ 🏠 server', value: `**${member.guild.name}**`, inline: true },
      { name: '⸻ 👥 total members', value: `**${joinNumber}**`, inline: true },
      { name: '⸻ 📌 joined', value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
    )
    .setImage(member.user.bannerURL({ size: 1024 }) || null)
    .setFooter({
      text: `id: ${member.id} · welcome to the family`,
      iconURL: member.guild.iconURL({ dynamic: true }) || undefined,
    })
    .setTimestamp();

  ch.send({ content: `> 🎊 everyone welcome <@${member.id}> to the server!`, embeds: [welcomeEmbed] }).catch(() => {});
  addLog('JOIN', `${member.user.username} joined ${member.guild.name}`, 'green');
  // send to audit join/leave channel
  const joinAuditEmbed = new EmbedBuilder()
    .setColor(0x00e87a)
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
    .setTitle('📥 member joined')
    .addFields(
      { name: '👤 user', value: `<@${member.id}>`, inline: true },
      { name: '🔢 member count', value: `${member.guild.memberCount}`, inline: true },
      { name: '📅 account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: 'user id: ' + member.id })
    .setTimestamp();
  sendAuditLog(member.guild, 'joinLeave', joinAuditEmbed);
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
  const timeInServer = member.joinedTimestamp
    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`
    : 'unknown';

  const goodbyeEmbed = new EmbedBuilder()
    .setColor(0xff3555)
    .setAuthor({
      name: `${member.guild.name}`,
      iconURL: member.guild.iconURL({ dynamic: true }) || undefined,
    })
    .setTitle(`${member.user.username} left the server 👋`)
    .setDescription(
      `> ${msg}\n\n` +
      `\`\`\`\nWe're down to ${member.guild.memberCount} members. They will be missed.\n\`\`\``
    )
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 512 }))
    .addFields(
      { name: '⸻ 👤 user', value: `**${member.user.username}**`, inline: true },
      { name: '⸻ 🔢 members left', value: `**${member.guild.memberCount}**`, inline: true },
      { name: '⸻ 📅 joined server', value: timeInServer, inline: true },
    )
    .setFooter({
      text: `id: ${member.id} · goodbye`,
      iconURL: member.user.displayAvatarURL({ dynamic: true }) || undefined,
    })
    .setTimestamp();

  ch.send({ embeds: [goodbyeEmbed] }).catch(() => {});
  addLog('LEAVE', `${member.user.username} left ${member.guild.name}`, 'yellow');
  const leaveAuditEmbed = new EmbedBuilder()
    .setColor(0xff3555)
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
    .setTitle('📤 member left')
    .addFields(
      { name: '👤 user', value: member.user.username, inline: true },
      { name: '🔢 members remaining', value: `${member.guild.memberCount}`, inline: true },
      { name: '📅 joined', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : '—', inline: true },
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setFooter({ text: 'user id: ' + member.id })
    .setTimestamp();
  sendAuditLog(member.guild, 'joinLeave', leaveAuditEmbed);
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

  // log command usage to audit channel
  const cmdEmbed = new EmbedBuilder()
    .setColor(0x4488ff)
    .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() })
    .setTitle('⌨️ command used')
    .addFields(
      { name: '💬 command', value: '`/' + cmd + '`', inline: true },
      { name: '👤 user', value: '<@' + interaction.user.id + '>', inline: true },
      { name: '📺 channel', value: '<#' + interaction.channel.id + '>', inline: true },
    )
    .setFooter({ text: 'user id: ' + interaction.user.id })
    .setTimestamp();
  sendAuditLog(interaction.guild, 'commands', cmdEmbed);

  try {
    if (cmd === 'ban') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'no reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.ban({ reason });
      addInfraction(user.username, 'ban', reason);
      addLog('MOD', `${user.username} was banned — ${reason}`, 'red');
      sendAuditLog(interaction.guild, 'modActions', new EmbedBuilder().setColor(0xff3555).setTitle('🔨 member banned').addFields({name:'👤 target',value:`<@${user.id}>`,inline:true},{name:'👮 mod',value:`<@${interaction.user.id}>`,inline:true},{name:'📋 reason',value:reason,inline:false}).setFooter({text:'user id: '+user.id}).setTimestamp());
      await interaction.reply({ embeds: [makeEmbed(0xff0000, '🔨 banned', `**${user.username}** was banned.\n**reason:** ${reason}`)] });
    }

    else if (cmd === 'kick') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'no reason';
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      addInfraction(user.username, 'kick', reason);
      addLog('MOD', `${user.username} was kicked — ${reason}`, 'red');
      sendAuditLog(interaction.guild, 'modActions', new EmbedBuilder().setColor(0xff8800).setTitle('👟 member kicked').addFields({name:'👤 target',value:`<@${user.id}>`,inline:true},{name:'👮 mod',value:`<@${interaction.user.id}>`,inline:true},{name:'📋 reason',value:reason,inline:false}).setFooter({text:'user id: '+user.id}).setTimestamp());
      await interaction.reply({ embeds: [makeEmbed(0xff4400, '👟 kicked', `**${user.username}** was kicked.\n**reason:** ${reason}`)] });
    }

    else if (cmd === 'warn') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'no reason';
      const count = addWarning(interaction.guild.id, user.id);
      addInfraction(user.username, 'warn', reason);
      addLog('MOD', `${user.username} warned (${count}) — ${reason}`, 'yellow');
      sendAuditLog(interaction.guild, 'modActions', new EmbedBuilder().setColor(0xffb700).setTitle('⚠️ member warned').addFields({name:'👤 target',value:`<@${user.id}>`,inline:true},{name:'👮 mod',value:`<@${interaction.user.id}>`,inline:true},{name:'⚠️ warnings',value:`${count}/${state.autobanThreshold}`,inline:true},{name:'📋 reason',value:reason,inline:false}).setFooter({text:'user id: '+user.id}).setTimestamp());
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
      const percent = Math.floor((d.xp / needed) * 100);
      const filledBars = Math.floor((d.xp / needed) * 20);
      const progressBar = '█'.repeat(filledBars) + '░'.repeat(20 - filledBars);
      const rankPos = Object.entries(state.xpData)
        .sort((a,b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
        .findIndex(([id]) => id === user.id) + 1;
      const tier = d.level >= 50 ? '💎 diamond' : d.level >= 30 ? '🥇 gold' : d.level >= 20 ? '🥈 silver' : d.level >= 10 ? '🥉 bronze' : '🌱 newcomer';
      const rankEmbed = new EmbedBuilder()
        .setColor(d.level >= 50 ? 0x00d4ff : d.level >= 30 ? 0xffb700 : d.level >= 20 ? 0xaaaaaa : d.level >= 10 ? 0xcd7f32 : 0x00e87a)
        .setAuthor({ name: `${user.username}'s rank card`, iconURL: user.displayAvatarURL({ dynamic: true }) })
        .setThumbnail(user.displayAvatarURL({ dynamic: true, size: 512 }))
        .setDescription(
          `**rank** \`#${rankPos}\` · **tier** ${tier}\n\n` +
          `**level ${d.level}** → **level ${d.level + 1}**\n` +
          `\`${progressBar}\` **${percent}%**`
        )
        .addFields(
          { name: '⭐ level', value: `\`${d.level}\``, inline: true },
          { name: '✨ total xp', value: `\`${d.xp + (d.level * (d.level - 1) * 50)}\``, inline: true },
          { name: '🏆 server rank', value: `\`#${rankPos}\``, inline: true },
          { name: '📈 xp this level', value: `\`${d.xp} / ${needed}\``, inline: true },
          { name: '⚡ xp needed', value: `\`${needed - d.xp}\``, inline: true },
          { name: '🎖️ tier', value: tier, inline: true },
        )
        .setFooter({ text: `${needed - d.xp} more xp to level up · keep chatting!` })
        .setTimestamp();
      await interaction.reply({ embeds: [rankEmbed] });
    }

    else if (cmd === 'leaderboard') {
      const sorted = Object.entries(state.xpData)
        .sort((a, b) => b[1].level - a[1].level || b[1].xp - a[1].xp)
        .slice(0, 10);
      const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
      const tiers = (lvl) => lvl >= 50 ? '💎' : lvl >= 30 ? '🥇' : lvl >= 20 ? '🥈' : lvl >= 10 ? '🥉' : '🌱';
      const rows = sorted.length
        ? sorted.map(([id, d], i) => {
            const pct = Math.floor((d.xp / (d.level * 100)) * 10);
            const bar = '█'.repeat(pct) + '░'.repeat(10 - pct);
            const totalXP = d.xp + (d.level * (d.level - 1) * 50);
            const line1 = medals[i] + ' <@' + id + '> ' + tiers(d.level);
            const line2 = '┗ **lvl ' + d.level + '** \u00b7 `' + bar + '` \u00b7 ' + totalXP.toLocaleString() + ' xp';
            return line1 + '\n' + line2;
          }).join('\n\n')
        : '> no one has earned xp yet — start chatting!';
      const topUser = sorted[0];
      const lbEmbed = new EmbedBuilder()
        .setColor(0xffb700)
        .setAuthor({
          name: interaction.guild.name + ' — leaderboard',
          iconURL: interaction.guild.iconURL({ dynamic: true }) || undefined,
        })
        .setTitle('🏆  top members')
        .setDescription(rows)
        .addFields(
          { name: '👥 ranked members', value: '**' + sorted.length + '**', inline: true },
          { name: '🌟 top level', value: topUser ? '**' + topUser[1].level + '**' : '—', inline: true },
          { name: '⚡ earn xp by', value: 'chatting (1min cooldown)', inline: true },
        )
        .setThumbnail(interaction.guild.iconURL({ dynamic: true }) || null)
        .setFooter({ text: 'use /rank to see your own stats · fa11en' })
        .setTimestamp();
      await interaction.reply({ embeds: [lbEmbed] });
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
        ).setFooter({ text: 'fa11en' }).setTimestamp()], ephemeral: true });
    }

  } catch (e) {
    console.error('command error:', e.message);
    const reply = { content: `error: ${e.message}`, ephemeral: true };
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

// ── AUDIT LOG HELPER ─────────────────────────────────
async function sendAuditLog(guild, type, embed) {
  const channelId = state.logChannels[type] || state.logChannelId;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId);
  if (!channel) return;
  channel.send({ embeds: [embed] }).catch(() => {});
}

// ── MESSAGE DELETE ─────────────────────────────────────
client.on('messageDelete', async message => {
  if (!message.guild || message.author?.bot) return;
  const embed = new EmbedBuilder()
    .setColor(0xff3555)
    .setAuthor({ name: message.author?.username || 'unknown', iconURL: message.author?.displayAvatarURL() || undefined })
    .setTitle('🗑️ message deleted')
    .addFields(
      { name: '👤 user', value: '<@' + (message.author?.id || '?') + '>', inline: true },
      { name: '📺 channel', value: '<#' + message.channel.id + '>', inline: true },
      { name: '🕐 sent at', value: '<t:' + Math.floor(message.createdTimestamp / 1000) + ':R>', inline: true },
    )
    .setFooter({ text: 'user id: ' + (message.author?.id || '?') })
    .setTimestamp();

  if (message.content) embed.setDescription('**content:**\n```\n' + message.content.slice(0, 1000) + '\n```');

  if (message.attachments.size > 0) {
    const att = message.attachments.first();
    embed.addFields({ name: '📎 attachment', value: att.name || 'file', inline: false });
    if (att.contentType?.startsWith('image/')) embed.setImage(att.proxyURL);
  }

  await sendAuditLog(message.guild, 'deletedMessages', embed);
  addLog('DELETE', (message.author?.username || '?') + ' deleted a message in #' + message.channel.name, 'red');
});

// ── MESSAGE EDIT ───────────────────────────────────────
client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  const embed = new EmbedBuilder()
    .setColor(0xffb700)
    .setAuthor({ name: newMsg.author?.username || 'unknown', iconURL: newMsg.author?.displayAvatarURL() || undefined })
    .setTitle('✏️ message edited')
    .addFields(
      { name: '👤 user', value: '<@' + newMsg.author?.id + '>', inline: true },
      { name: '📺 channel', value: '<#' + newMsg.channel.id + '>', inline: true },
      { name: '🔗 jump', value: '[click here](' + newMsg.url + ')', inline: true },
      { name: '❌ before', value: '```' + (oldMsg.content || 'unknown').slice(0, 500) + '```' },
      { name: '✅ after', value: '```' + (newMsg.content || '').slice(0, 500) + '```' },
    )
    .setFooter({ text: 'user id: ' + newMsg.author?.id })
    .setTimestamp();
  await sendAuditLog(newMsg.guild, 'editedMessages', embed);
  addLog('EDIT', newMsg.author?.username + ' edited a message in #' + newMsg.channel.name, 'yellow');
});

// ── IMAGE / FILE UPLOAD ────────────────────────────────
client.on('messageCreate', async message => {
  if (!message.guild || message.author?.bot) return;
  if (message.attachments.size === 0) return;
  message.attachments.forEach(att => {
    const isImage = att.contentType?.startsWith('image/');
    const embed = new EmbedBuilder()
      .setColor(0x00d4ff)
      .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL() })
      .setTitle(isImage ? '🖼️ image uploaded' : '📎 file uploaded')
      .addFields(
        { name: '👤 user', value: '<@' + message.author.id + '>', inline: true },
        { name: '📺 channel', value: '<#' + message.channel.id + '>', inline: true },
        { name: '📄 file', value: att.name || 'unknown', inline: true },
        { name: '📦 size', value: att.size ? (att.size / 1024).toFixed(1) + ' KB' : 'unknown', inline: true },
      )
      .setFooter({ text: 'user id: ' + message.author.id })
      .setTimestamp();
    if (isImage) embed.setImage(att.proxyURL);
    sendAuditLog(message.guild, 'images', embed);
    addLog('FILE', message.author.username + ' uploaded ' + (att.name || 'file') + ' in #' + message.channel.name, 'cyan');
  });
});

// ── VOICE ACTIVITY ─────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  if (!newState.guild || newState.member?.user?.bot) return;
  const member = newState.member;
  let action, color;

  if (!oldState.channelId && newState.channelId) {
    action = '🎤 joined voice — <#' + newState.channelId + '>';
    color = 0x00e87a;
  } else if (oldState.channelId && !newState.channelId) {
    action = '🔇 left voice — <#' + oldState.channelId + '>';
    color = 0xff3555;
  } else if (oldState.channelId !== newState.channelId) {
    action = '🔀 moved from <#' + oldState.channelId + '> to <#' + newState.channelId + '>';
    color = 0xffb700;
  } else return;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: member.user.username, iconURL: member.user.displayAvatarURL() })
    .setTitle('🎙️ voice activity')
    .setDescription(action)
    .addFields({ name: '👤 user', value: '<@' + member.id + '>', inline: true })
    .setFooter({ text: 'user id: ' + member.id })
    .setTimestamp();
  await sendAuditLog(newState.guild, 'voiceActivity', embed);
  addLog('VOICE', member.user.username + ' ' + action.replace(/<#[0-9]+>/g, '').trim(), 'blue');
});

// ── ROLE CHANGES ───────────────────────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const added = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
  const removed = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
  if (added.size === 0 && removed.size === 0) return;

  const embed = new EmbedBuilder()
    .setColor(0x9b8cff)
    .setAuthor({ name: newMember.user.username, iconURL: newMember.user.displayAvatarURL() })
    .setTitle('🏷️ roles updated');

  if (added.size > 0) embed.addFields({ name: '✅ roles added', value: added.map(r => '<@&' + r.id + '>').join(', '), inline: false });
  if (removed.size > 0) embed.addFields({ name: '❌ roles removed', value: removed.map(r => '<@&' + r.id + '>').join(', '), inline: false });

  embed.addFields({ name: '👤 user', value: '<@' + newMember.id + '>', inline: true })
    .setFooter({ text: 'user id: ' + newMember.id })
    .setTimestamp();

  await sendAuditLog(newMember.guild, 'roleChanges', embed);
  addLog('ROLE', newMember.user.username + ' roles changed', 'purple');
});

// ── TEMP VOICE ───────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  // --- create temp channel when joining creator ---
  if (state.tempVoiceEnabled && state.tempVoiceCreatorId &&
      newState.channelId === state.tempVoiceCreatorId) {
    const guild = newState.guild;
    const member = newState.member;
    try {
      const newCh = await guild.channels.create({
        name: member.displayName + "'s channel",
        type: 2, // voice
        parent: state.tempVoiceCategoryId || undefined,
        permissionOverwrites: [
          {
            id: member.id,
            allow: [
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.MoveMembers,
              PermissionFlagsBits.MuteMembers,
              PermissionFlagsBits.DeafenMembers,
              PermissionFlagsBits.Connect,
              PermissionFlagsBits.Speak,
              PermissionFlagsBits.ViewChannel,
            ]
          }
        ]
      });
      state.tempVoiceChannels[newCh.id] = {
        ownerId: member.id,
        guildId: guild.id,
        name: newCh.name,
        limit: 0,
      };
      await member.voice.setChannel(newCh);
      addLog('VOICE', member.user.username + ' created temp vc: ' + newCh.name, 'cyan');
    } catch(e) { addLog('VOICE', 'failed to create temp vc: ' + e.message, 'red'); }
  }

  // --- delete temp channel when empty ---
  if (oldState.channelId && state.tempVoiceChannels[oldState.channelId]) {
    const ch = oldState.guild.channels.cache.get(oldState.channelId);
    if (ch && ch.members.size === 0) {
      delete state.tempVoiceChannels[oldState.channelId];
      await ch.delete('temp voice empty').catch(() => {});
      addLog('VOICE', 'temp vc deleted (empty)', 'yellow');
    }
  }
});

// ── REACTION VERIFICATION ────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (!state.verificationEnabled) return;
  if (!state.verifyMessageId) return;

  // handle partial reactions
  if (reaction.partial) {
    try { await reaction.fetch(); } catch (e) { return; }
  }

  // check if this is the verify message
  if (reaction.message.id !== state.verifyMessageId) return;

  // check emoji matches
  const emoji = reaction.emoji.name;
  if (emoji !== state.verifyEmoji) {
    // remove wrong reaction
    await reaction.users.remove(user.id).catch(() => {});
    return;
  }

  try {
    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);

    // give verified role
    if (state.verifiedRoleId) {
      await member.roles.add(state.verifiedRoleId).catch(() => {});
    }

    // remove unverified role
    if (state.unverifiedRoleId) {
      await member.roles.remove(state.unverifiedRoleId).catch(() => {});
    }

    // remove their reaction so others can see it's clean
    await reaction.users.remove(user.id).catch(() => {});

    addLog('VERIFY', member.user.username + ' verified via reaction', 'green');

    // DM the user
    user.send('✅ you have been verified in **' + guild.name + '**! you now have access to all channels.').catch(() => {});

  } catch (e) {
    addLog('VERIFY', 'reaction verify failed for ' + user.username + ': ' + e.message, 'red');
  }
});

// ── VERIFICATION HELPERS ─────────────────────────────
function createVerifyToken(userId, guildId) {
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  state.pendingVerifications[token] = {
    userId,
    guildId,
    roleId: state.verifiedRoleId, // snapshot the role id at creation time
    expires: Date.now() + 15 * 60 * 1000, // 15 min
  };
  return token;
}

async function completeVerification(token, overrideRoleId) {
  const data = state.pendingVerifications[token];
  if (!data) return { ok: false, error: 'invalid or expired token — please click verify again in Discord' };
  if (Date.now() > data.expires) {
    delete state.pendingVerifications[token];
    return { ok: false, error: 'token expired — please click the verify button again in Discord' };
  }
  // use override role id, or saved one, or the one stored in the token itself
  const roleId = overrideRoleId || state.verifiedRoleId || data.roleId;
  if (!roleId) return { ok: false, error: 'verified role not set — go to dashboard → Verification → set the role id and save' };
  try {
    const guild = client.guilds.cache.get(data.guildId);
    if (!guild) return { ok: false, error: 'bot is not in that server' };
    let member;
    try { member = await guild.members.fetch(data.userId); }
    catch(e) { return { ok: false, error: 'could not find you in the server — make sure you are a member' }; }
    await member.roles.add(roleId);
    delete state.pendingVerifications[token];
    addLog('VERIFY', member.user.username + ' verified and got role', 'green');
    return { ok: true, username: member.user.username };
  } catch (e) {
    if (e.message.includes('Missing Permissions')) {
      return { ok: false, error: 'bot is missing permissions — make sure the bot role is above the verified role in server settings' };
    }
    return { ok: false, error: e.message };
  }
}

// cleanup expired tokens every 5 min
setInterval(() => {
  const now = Date.now();
  Object.keys(state.pendingVerifications).forEach(t => {
    if (state.pendingVerifications[t].expires < now) delete state.pendingVerifications[t];
  });
}, 5 * 60 * 1000);

client.login(TOKEN).catch(e => console.error('❌ login failed:', e.message));

module.exports = { client, state, addLog, addWarning, getWarnings, clearWarnings, addInfraction, createVerifyToken, completeVerification, saveState };
