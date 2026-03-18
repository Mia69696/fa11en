require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Partials,
  SlashCommandBuilder, Routes, EmbedBuilder,
  PermissionFlagsBits, REST, ActivityType
} = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;

// ── STATE ─────────────────────────────────────────────
const state = {
  blockInvites:true, blockSpam:true, badWordsFilter:true,
  blockMassMentions:true, capsFilter:false, blockLinks:false,
  welcomeEnabled:true, goodbyeEnabled:true, levelingEnabled:true, ticketsEnabled:true,
  welcomeMessage:"welcome to the server, {user}! you're member #{count}.",
  goodbyeMessage:'{user} has left the server.',
  levelUpMessage:'gg {user}, you hit level {level}!',
  welcomeChannelId:null, logChannelId:null,
  logChannels:{ deletedMessages:null, editedMessages:null, joinLeave:null,
    modActions:null, commands:null, images:null, voiceActivity:null, roleChanges:null },
  autobanThreshold:3, prefix:'!', muteMinutes:10,
  badWordsList:['badword1','badword2'],
  xpData:{}, warnings:{}, infractions:[], infId:1, logs:[], tickets:{}, ticketCount:0, ticketPanelChannels:{},
  // temp voice
  tempVoiceEnabled:true,
  tempVoiceGuilds:{},    // guildId -> { categoryId, creatorId, controlChannelId }
  tempVoiceChannels:{},  // channelId -> { ownerId, guildId, name, limit, locked, hidden, trustedUsers, bannedUsers, controlMsgId, region }
  // verification
  verificationEnabled:false, verifiedRoleId:null, unverifiedRoleId:null,
  verificationChannelId:null, verifyMessageId:null, verifyEmoji:'✅',
  pendingVerifications:{},
};

// ── PERSISTENCE ───────────────────────────────────────
const SAVE_FILE = path.join(__dirname, 'data.json');
const PERSIST_KEYS = [
  'blockInvites','blockSpam','badWordsFilter','blockMassMentions','capsFilter','blockLinks',
  'welcomeEnabled','goodbyeEnabled','levelingEnabled','ticketsEnabled',
  'welcomeMessage','goodbyeMessage','levelUpMessage',
  'welcomeChannelId','logChannelId','autobanThreshold','prefix','muteMinutes','badWordsList',
  'verificationEnabled','verifiedRoleId','unverifiedRoleId','verificationChannelId',
  'verifyMessageId','verifyEmoji','logChannels','tempVoiceEnabled','tempVoiceGuilds',
  'xpData','warnings','infractions','infId','ticketCount','ticketPanelChannels',
];

function saveState() {
  try {
    const o = {}; PERSIST_KEYS.forEach(k => { o[k] = state[k]; });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(o, null, 2));
  } catch(e) { console.error('save err:', e.message); }
}
function loadState() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const s = JSON.parse(fs.readFileSync(SAVE_FILE,'utf8'));
    Object.keys(s).forEach(k => { if (PERSIST_KEYS.includes(k)) state[k] = s[k]; });
    if (!state.tempVoiceGuilds) state.tempVoiceGuilds = {};
    console.log('✅ state loaded');
  } catch(e) { console.error('load err:', e.message); }
}
loadState();
setInterval(saveState, 30000);

// ── HELPERS ───────────────────────────────────────────
function addLog(type, msg, color='blue', detail=null) {
  const time = new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const e = { type, msg, color, time };
  if (detail) e.detail = detail;
  state.logs.unshift(e);
  if (state.logs.length > 500) state.logs.pop();
}
function getXP(id)  { if (!state.xpData[id]) state.xpData[id]={xp:0,level:1}; return state.xpData[id]; }
function addXP(id, amt) { const d=getXP(id); d.xp+=amt; const need=d.level*100; if(d.xp>=need){d.xp-=need;d.level++;return true;} return false; }
function getWarnings(gid,uid) { return (state.warnings[gid]||{})[uid]||0; }
function addWarning(gid,uid)  { if(!state.warnings[gid])state.warnings[gid]={}; state.warnings[gid][uid]=(state.warnings[gid][uid]||0)+1; return state.warnings[gid][uid]; }
function clearWarnings(gid,uid){ if(state.warnings[gid])state.warnings[gid][uid]=0; }
function addInfraction(user,act,reason){ state.infractions.unshift({id:state.infId++,user,act,reason,time:new Date().toLocaleTimeString()}); if(state.infractions.length>500)state.infractions.pop(); }
function makeEmbed(color,title,desc){ return new EmbedBuilder().setColor(color).setTitle(title).setDescription(desc).setTimestamp(); }

async function sendAuditLog(guild, type, embed) {
  const id = state.logChannels[type] || state.logChannelId;
  if (!id) return;
  const ch = guild.channels.cache.get(id);
  if (ch) ch.send({ embeds:[embed] }).catch(()=>{});
}

const spamMap = {}, xpCooldown = new Set();
function isSpam(uid) {
  const now=Date.now(); if(!spamMap[uid])spamMap[uid]=[];
  spamMap[uid]=spamMap[uid].filter(t=>now-t<5000); spamMap[uid].push(now);
  return spamMap[uid].length>=5;
}
const INVITE_RE=/(discord\.gg|discord\.com\/invite)\/[a-zA-Z0-9-]+/gi;
const LINK_RE=/https?:\/\/[^\s]+/gi;

// ── CLIENT ────────────────────────────────────────────
const client = new Client({
  intents:[
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.GuildVoiceStates,
  ],
  partials:[Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction],
});

// ── SLASH COMMANDS ────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .addStringOption(o=>o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('mute').setDescription('Timeout a member')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .addIntegerOption(o=>o.setName('minutes').setDescription('Minutes'))
    .addStringOption(o=>o.setName('reason').setDescription('Reason'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('unmute').setDescription('Remove timeout')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('warnings').setDescription('Check warnings')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('clearwarnings').setDescription('Clear warnings')
    .addUserOption(o=>o.setName('user').setDescription('User').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  new SlashCommandBuilder().setName('purge').setDescription('Delete messages')
    .addIntegerOption(o=>o.setName('amount').setDescription('Amount').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('rank').setDescription('Check XP rank')
    .addUserOption(o=>o.setName('user').setDescription('User')),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Top members by XP'),
  new SlashCommandBuilder().setName('serverinfo').setDescription('Server info'),
  new SlashCommandBuilder().setName('userinfo').setDescription('User info')
    .addUserOption(o=>o.setName('user').setDescription('User')),
  new SlashCommandBuilder().setName('ticket').setDescription('Open a support ticket'),
  new SlashCommandBuilder().setName('closeticket').setDescription('Close this ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('ticketpanel').setDescription('Post a ticket panel with a button')
    .addChannelOption(o=>o.setName('channel').setDescription('Channel to post in (default: current)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  new SlashCommandBuilder().setName('say').setDescription('Make the bot say something')
    .addStringOption(o=>o.setName('message').setDescription('Message').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
  new SlashCommandBuilder().setName('ping').setDescription('Check ping'),
  new SlashCommandBuilder().setName('help').setDescription('All commands'),
].map(c=>c.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({version:'10'}).setToken(TOKEN);
  try { await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), {body:commands}); }
  catch(e) { console.error('register err:', e.message); }
}

// ── TEMP VOICE ────────────────────────────────────────
function tvCfg(guildId) {
  if (!state.tempVoiceGuilds) state.tempVoiceGuilds = {};
  return state.tempVoiceGuilds[guildId] || {};
}

function tvEmbed(ch, channelId) {
  return new EmbedBuilder()
    .setColor(0x00d4ff)
    .setTitle('🎙️ ' + (ch.name || 'your channel'))
    .setDescription('> manage your temp voice channel using the buttons below\n> only the **channel owner** can use these controls')
    .addFields(
      { name:'👑 owner',   value:'<@'+ch.ownerId+'>', inline:true },
      { name:'👥 limit',   value:ch.limit ? ch.limit+' users' : '∞ unlimited', inline:true },
      { name:'🔒 status',  value:ch.locked ? '🔒 locked' : ch.hidden ? '👁️ hidden' : '🔓 public', inline:true },
      { name:'🌐 region',  value:ch.region||'automatic', inline:true },
      { name:'🤝 trusted', value:ch.trustedUsers?.length ? ch.trustedUsers.map(i=>'<@'+i+'>').join(', ') : 'none', inline:true },
      { name:'🚫 blocked', value:ch.bannedUsers?.length ? ch.bannedUsers.length+' user(s)' : 'none', inline:true },
    )
    .setFooter({ text:'fa11en temp voice · '+channelId })
    .setTimestamp();
}

function tvRows(channelId) {
  return [
    { type:1, components:[
      { type:2, style:1, label:'NAME',    emoji:'✏️', custom_id:'tv_name_'+channelId },
      { type:2, style:1, label:'LIMIT',   emoji:'👥', custom_id:'tv_limit_'+channelId },
      { type:2, style:1, label:'PRIVACY', emoji:'🔒', custom_id:'tv_privacy_'+channelId },
      { type:2, style:1, label:'REGION',  emoji:'🌐', custom_id:'tv_region_'+channelId },
      { type:2, style:2, label:'CHAT',    emoji:'💬', custom_id:'tv_chat_'+channelId },
    ]},
    { type:1, components:[
      { type:2, style:2, label:'TRUST',        emoji:'🤝', custom_id:'tv_trust_'+channelId },
      { type:2, style:2, label:'UNTRUST',      emoji:'💔', custom_id:'tv_untrust_'+channelId },
      { type:2, style:2, label:'INVITE',       emoji:'📨', custom_id:'tv_invite_'+channelId },
      { type:2, style:4, label:'KICK',         emoji:'👟', custom_id:'tv_kick_'+channelId },
      { type:2, style:1, label:'WAITING ROOM', emoji:'⏳', custom_id:'tv_wait_'+channelId },
    ]},
    { type:1, components:[
      { type:2, style:4, label:'BLOCK',    emoji:'🚫', custom_id:'tv_block_'+channelId },
      { type:2, style:2, label:'UNBLOCK',  emoji:'✅', custom_id:'tv_unblock_'+channelId },
      { type:2, style:1, label:'CLAIM',    emoji:'👑', custom_id:'tv_claim_'+channelId },
      { type:2, style:1, label:'TRANSFER', emoji:'🔄', custom_id:'tv_transfer_'+channelId },
      { type:2, style:4, label:'DELETE',   emoji:'🗑️', custom_id:'tv_delete_'+channelId },
    ]},
  ];
}

async function tvSendPanel(guild, channelId) {
  const ch   = state.tempVoiceChannels[channelId];
  const cfg  = tvCfg(guild.id);
  const ctrlId = cfg.controlChannelId;
  if (!ch || !ctrlId) return;
  const ctrl = guild.channels.cache.get(ctrlId);
  if (!ctrl) return;
  if (ch.controlMsgId) {
    const old = await ctrl.messages.fetch(ch.controlMsgId).catch(()=>null);
    if (old) await old.delete().catch(()=>{});
  }
  const msg = await ctrl.send({ embeds:[tvEmbed(ch,channelId)], components:tvRows(channelId) }).catch(e=>{console.error('panel err:',e.message);return null;});
  if (msg) { ch.controlMsgId = msg.id; }
}

async function tvUpdatePanel(guild, channelId) {
  const ch   = state.tempVoiceChannels[channelId];
  const cfg  = tvCfg(guild.id);
  const ctrlId = cfg.controlChannelId;
  if (!ch || !ctrlId) return;
  const ctrl = guild.channels.cache.get(ctrlId);
  if (!ctrl) return;
  if (!ch.controlMsgId) return tvSendPanel(guild, channelId);
  const msg = await ctrl.messages.fetch(ch.controlMsgId).catch(()=>null);
  if (!msg) return tvSendPanel(guild, channelId);
  await msg.edit({ embeds:[tvEmbed(ch,channelId)], components:tvRows(channelId) }).catch(()=>{});
}

async function tvAutoSetup(guild) {
  if (!state.tempVoiceGuilds) state.tempVoiceGuilds = {};
  const cfg = state.tempVoiceGuilds[guild.id];
  if (cfg?.creatorId) {
    const exists = guild.channels.cache.get(cfg.creatorId);
    if (exists) {
      // resend welcome if control ch is empty
      if (cfg.controlChannelId) {
        const ctrl = guild.channels.cache.get(cfg.controlChannelId);
        if (ctrl) {
          const msgs = await ctrl.messages.fetch({limit:5}).catch(()=>null);
          if (msgs && msgs.size === 0) await tvSendWelcome(ctrl);
        }
      }
      return;
    }
  }
  try {
    const category = await guild.channels.create({ name:'🔊 Temp Voice', type:4 });
    const creator  = await guild.channels.create({ name:'➕ Join to Create', type:2, parent:category.id });
    const ctrl     = await guild.channels.create({
      name:'🎛️-vc-controls', type:0, parent:category.id,
      permissionOverwrites:[{ id:guild.id, deny:['ViewChannel'] }],
      topic:'your temp voice control panel appears here',
    });
    state.tempVoiceGuilds[guild.id] = { categoryId:category.id, creatorId:creator.id, controlChannelId:ctrl.id };
    state.tempVoiceEnabled = true;
    saveState();
    await tvSendWelcome(ctrl);
    addLog('VOICE','temp voice setup in '+guild.name,'green');
    console.log('✅ temp voice setup:', guild.name);
  } catch(e) {
    console.error('tv setup err:', e.message);
    addLog('VOICE','tv setup failed: '+e.message,'red');
  }
}

async function tvSendWelcome(ctrl) {
  await ctrl.send({ embeds:[new EmbedBuilder()
    .setColor(0x00d4ff)
    .setTitle('🎙️ temp voice ready!')
    .setDescription('> join **➕ Join to Create** to get your own voice channel\n> your control panel will appear here when you join')
    .addFields(
      { name:'✏️ NAME',   value:'rename your vc',        inline:true },
      { name:'🔒 PRIVACY',value:'lock or hide it',       inline:true },
      { name:'👥 LIMIT',  value:'set user limit',        inline:true },
      { name:'🤝 TRUST',  value:'let friends in when locked', inline:true },
      { name:'🚫 BLOCK',  value:'kick + ban someone',    inline:true },
      { name:'🔄 TRANSFER',value:'give ownership',       inline:true },
    )
    .setFooter({ text:'fa11en · channel auto-deletes when everyone leaves' })
    .setTimestamp()
  ]}).catch(()=>{});
}

// ── READY ─────────────────────────────────────────────
// ── TICKET AUTO SETUP ────────────────────────────────
async function ticketAutoSetup(guild) {
  try {
    if (!state.ticketPanelChannels) state.ticketPanelChannels = {};
    const existingId = state.ticketPanelChannels[guild.id];
    if (existingId) {
      const existing = guild.channels.cache.get(existingId);
      if (existing) return;
    }
    let category = guild.channels.cache.find(ch => ch.type === 4 && ch.name.toLowerCase().includes('ticket'));
    if (!category) category = await guild.channels.create({ name: '🎫 Tickets', type: 4 });
    const panelCh = await guild.channels.create({
      name: '📋-create-ticket', type: 0, parent: category.id,
      permissionOverwrites: [
        { id: guild.id, allow: ['ViewChannel','ReadMessageHistory'], deny: ['SendMessages'] },
        { id: client.user.id, allow: ['ViewChannel','SendMessages','ManageChannels','ReadMessageHistory'] },
      ],
      topic: 'click the button to open a support ticket',
    });
    const botAvatar = client.user.displayAvatarURL({ dynamic:true, size:512 });
    const embed = new EmbedBuilder()
      .setColor(0x2b2d31)
      .setAuthor({ name: 'Staff Support', iconURL: botAvatar })
      .setTitle('Do you need help with something?')
      .setDescription('Contact our staff team privately so we can assist you with whatever you need.\n\n**Additional Information:**\n> \u2726 If it\'s urgent, just mention one of our staff members.\n> \u2726 Please give us clear information.')
      .setThumbnail(botAvatar)
      .setFooter({ text: 'fa11en \u00b7 support system', iconURL: botAvatar })
      .setTimestamp();
    await panelCh.send({ embeds:[embed], components:[{ type:1, components:[{ type:2, style:1, label:'Create Ticket', emoji:'🎫', custom_id:'open_ticket' }]}] });
    state.ticketPanelChannels[guild.id] = panelCh.id;
    saveState();
    addLog('TICKET','ticket panel auto-setup in '+guild.name,'cyan');
    console.log('✅ ticket setup:', guild.name);
  } catch(e) { console.error('ticket setup err:', e.message); }
}

client.once('ready', async () => {
  console.log('🤖 fa11en online:', client.user.tag);
  client.user.setActivity('your server', { type:ActivityType.Watching });
  addLog('START','bot online as '+client.user.tag,'green');
  for (const g of client.guilds.cache.values()) {
    await registerCommands(g.id);
    await tvAutoSetup(g);
    await ticketAutoSetup(g);
  }
});

client.on('guildCreate', async g => {
  await registerCommands(g.id);
  await tvAutoSetup(g);
  await ticketAutoSetup(g);
  addLog('JOIN','bot joined: '+g.name,'green');
});

// ── WELCOME / GOODBYE ─────────────────────────────────
client.on('guildMemberAdd', async member => {
  if (!state.welcomeEnabled) return;
  const ch = state.welcomeChannelId ? member.guild.channels.cache.get(state.welcomeChannelId) : member.guild.systemChannel;
  if (!ch) return;
  const msg = state.welcomeMessage.replace(/{user}/g,`<@${member.id}>`).replace(/{count}/g,member.guild.memberCount).replace(/{server}/g,member.guild.name);
  const welcomeEmbed = new EmbedBuilder()
    .setColor(0x00e87a)
    .setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL({ dynamic:true }) || undefined })
    .setTitle('welcome to the server! 🎉')
    .setDescription('> ' + msg + '\n\u200b')
    .setThumbnail(member.user.displayAvatarURL({ dynamic:true, size:512 }))
    .setImage(member.user.bannerURL({ size:1024 }) || null)
    .addFields(
      { name: '👤 user',       value: `<@${member.id}>`, inline: true },
      { name: '🔢 member #',  value: `**${member.guild.memberCount}**`, inline: true },
      { name: '📅 acc age',   value: `<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`, inline: true },
    )
    .setFooter({ text: 'fa11en · id: '+member.id, iconURL: member.guild.iconURL({ dynamic:true }) || undefined })
    .setTimestamp();
  ch.send({ content: `> 👋 welcome <@${member.id}>!`, embeds: [welcomeEmbed] }).catch(()=>{});
  sendAuditLog(member.guild,'joinLeave',new EmbedBuilder().setColor(0x00e87a).setAuthor({name:member.user.username+' joined',iconURL:member.user.displayAvatarURL()}).addFields({name:'👤 user',value:`<@${member.id}>`,inline:true},{name:'🔢 member count',value:`${member.guild.memberCount}`,inline:true},{name:'📅 account created',value:`<t:${Math.floor(member.user.createdTimestamp/1000)}:R>`,inline:true}).setThumbnail(member.user.displayAvatarURL()).setFooter({text:'id: '+member.id}).setTimestamp());
  addLog('JOIN',member.user.username+' joined '+member.guild.name,'green',`user: ${member.user.username} (${member.id})\naccount created: ${new Date(member.user.createdTimestamp).toLocaleString()}\nmember #${member.guild.memberCount}`);
});

client.on('guildMemberRemove', async member => {
  if (!state.goodbyeEnabled) return;
  const ch = state.welcomeChannelId ? member.guild.channels.cache.get(state.welcomeChannelId) : member.guild.systemChannel;
  if (!ch) return;
  const msg = state.goodbyeMessage.replace(/{user}/g,member.user.username).replace(/{server}/g,member.guild.name);
  const goodbyeEmbed = new EmbedBuilder()
    .setColor(0xff3555)
    .setAuthor({ name: member.guild.name, iconURL: member.guild.iconURL({ dynamic:true }) || undefined })
    .setTitle(member.user.username + ' left the server 👋')
    .setDescription('> ' + msg + '\n\u200b')
    .setThumbnail(member.user.displayAvatarURL({ dynamic:true, size:512 }))
    .addFields(
      { name: '👤 user',          value: member.user.username, inline: true },
      { name: '🔢 members left',  value: `**${member.guild.memberCount}**`, inline: true },
      { name: '📅 joined',        value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp/1000)}:R>` : '—', inline: true },
    )
    .setFooter({ text: 'fa11en · id: '+member.id, iconURL: member.guild.iconURL({ dynamic:true }) || undefined })
    .setTimestamp();
  ch.send({ embeds: [goodbyeEmbed] }).catch(()=>{});
  sendAuditLog(member.guild,'joinLeave',new EmbedBuilder().setColor(0xff3555).setAuthor({name:member.user.username+' left',iconURL:member.user.displayAvatarURL()}).addFields({name:'👤 user',value:member.user.username,inline:true},{name:'🔢 members remaining',value:`${member.guild.memberCount}`,inline:true}).setThumbnail(member.user.displayAvatarURL()).setFooter({text:'id: '+member.id}).setTimestamp());
  addLog('LEAVE',member.user.username+' left '+member.guild.name,'yellow',`user: ${member.user.username} (${member.id})\nmembers now: ${member.guild.memberCount}`);
});

// ── AUTOMOD + XP ─────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);
  const isMod   = message.member?.permissions.has(PermissionFlagsBits.ModerateMembers);

  if (!isAdmin && !isMod) {
    const content = message.content;
    if (state.blockInvites && INVITE_RE.test(content)) {
      await message.delete().catch(()=>{});
      const w = addWarning(message.guild.id, message.author.id);
      const r = await message.channel.send({embeds:[makeEmbed(0xff0000,'🚫 invite blocked',`<@${message.author.id}> no invite links. warning **${w}/${state.autobanThreshold}**`)]});
      setTimeout(()=>r.delete().catch(()=>{}), 5000);
      addLog('AUTOMOD',message.author.username+' posted invite link (warn '+w+')','red',`content: ${content}\nchannel: #${message.channel.name}`);
      if (w>=state.autobanThreshold) message.member.ban({reason:'automod'}).catch(()=>{});
      return;
    }
    if (state.blockLinks && LINK_RE.test(content)) {
      await message.delete().catch(()=>{});
      const r=await message.channel.send({embeds:[makeEmbed(0xff0000,'🚫 link blocked',`<@${message.author.id}> no links here.`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000); return;
    }
    if (state.badWordsFilter && state.badWordsList.some(w=>content.toLowerCase().includes(w.toLowerCase()))) {
      await message.delete().catch(()=>{});
      const w=addWarning(message.guild.id,message.author.id);
      const r=await message.channel.send({embeds:[makeEmbed(0xff0000,'🚫 message removed',`<@${message.author.id}> warning **${w}/${state.autobanThreshold}**`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000);
      addLog('AUTOMOD',message.author.username+' used bad word','red',`content: ${content}`);
      if (w>=state.autobanThreshold) message.member.ban({reason:'automod'}).catch(()=>{}); return;
    }
    if (state.blockSpam && isSpam(message.author.id)) {
      await message.delete().catch(()=>{});
      await message.member.timeout(state.muteMinutes*60000,'spamming').catch(()=>{});
      const r=await message.channel.send({embeds:[makeEmbed(0xff8800,'⚠️ spam',`<@${message.author.id}> timed out ${state.muteMinutes}min`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000); return;
    }
    if (state.blockMassMentions && message.mentions.users.size>=3) {
      await message.delete().catch(()=>{});
      const w=addWarning(message.guild.id,message.author.id);
      const r=await message.channel.send({embeds:[makeEmbed(0xff8800,'⚠️ mass mention',`<@${message.author.id}> warning **${w}/${state.autobanThreshold}**`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000); return;
    }
    if (state.capsFilter && content.length>8) {
      const letters=content.replace(/[^a-zA-Z]/g,'');
      if (letters.length>5 && letters.split('').filter(c=>c===c.toUpperCase()).length/letters.length>0.7) {
        await message.delete().catch(()=>{});
        const r=await message.channel.send({embeds:[makeEmbed(0xff8800,'⚠️ caps filter',`<@${message.author.id}> stop yelling.`)]});
        setTimeout(()=>r.delete().catch(()=>{}),4000); return;
      }
    }
  }

  // XP
  if (state.levelingEnabled && !xpCooldown.has(message.author.id)) {
    xpCooldown.add(message.author.id);
    setTimeout(()=>xpCooldown.delete(message.author.id),60000);
    const leveled = addXP(message.author.id, Math.floor(Math.random()*10)+5);
    if (leveled) {
      const d=getXP(message.author.id);
      const lvlMsg=state.levelUpMessage.replace(/{user}/g,`<@${message.author.id}>`).replace(/{level}/g,d.level);
      const r=await message.channel.send({embeds:[makeEmbed(0x00ff88,'🎉 level up!',lvlMsg)]});
      setTimeout(()=>r.delete().catch(()=>{}),10000);
    }
  }

  // image/file logging
  if (message.attachments.size > 0) {
    message.attachments.forEach(att => {
      const isImg = att.contentType?.startsWith('image/');
      const e = new EmbedBuilder().setColor(0x00d4ff).setAuthor({name:message.author.username,iconURL:message.author.displayAvatarURL()}).setTitle(isImg?'🖼️ image uploaded':'📎 file uploaded').addFields({name:'👤 user',value:`<@${message.author.id}>`,inline:true},{name:'📺 channel',value:`<#${message.channel.id}>`,inline:true},{name:'📄 file',value:att.name||'?',inline:true},{name:'📦 size',value:att.size?(att.size/1024).toFixed(1)+'KB':'?',inline:true}).setFooter({text:'user id: '+message.author.id}).setTimestamp();
      if (isImg) e.setImage(att.proxyURL);
      sendAuditLog(message.guild,'images',e);
      addLog('FILE',message.author.username+' uploaded '+(att.name||'file')+' in #'+message.channel.name,'cyan',`user: ${message.author.username} (${message.author.id})\nfile: ${att.name}\nsize: ${att.size?(att.size/1024).toFixed(1)+'KB':'?'}\nurl: ${att.url}`);
    });
  }
});

// ── MESSAGE DELETE ────────────────────────────────────
client.on('messageDelete', async message => {
  if (!message.guild || message.author?.bot) return;
  const embed = new EmbedBuilder()
    .setColor(0xff3555)
    .setAuthor({name:(message.author?.username||'unknown')+' — deleted message', iconURL:message.author?.displayAvatarURL()||undefined})
    .setTitle('🗑️ message deleted')
    .addFields(
      { name:'👤 author',   value:'<@'+(message.author?.id||'?')+'>', inline:true },
      { name:'📺 channel',  value:'<#'+message.channel.id+'>', inline:true },
      { name:'🕐 sent',     value:'<t:'+Math.floor(message.createdTimestamp/1000)+':R>', inline:true },
      { name:'🆔 msg id',   value:message.id, inline:true },
      { name:'🆔 user id',  value:message.author?.id||'?', inline:true },
      { name:'📎 attachments', value:message.attachments.size?message.attachments.size+' file(s)':'none', inline:true },
    )
    .setFooter({text:'#'+message.channel.name+' · '+message.guild.name})
    .setTimestamp();
  if (message.content) embed.setDescription('**📝 content:**\n```\n'+message.content.slice(0,1000)+'\n```');
  if (message.attachments.size>0) {
    const img=message.attachments.find(a=>a.contentType?.startsWith('image/'));
    if (img) embed.setImage(img.proxyURL);
  }
  await sendAuditLog(message.guild,'deletedMessages',embed);
  const detail=`user: ${message.author?.username||'?'} (${message.author?.id||'?'})\nchannel: #${message.channel.name}\ncontent: ${message.content||'[no text]'}${message.attachments.size?' \nattachments: '+message.attachments.map(a=>a.name).join(', '):''}`;
  addLog('DELETE',(message.author?.username||'?')+' deleted a message in #'+message.channel.name,'red',detail);
});

// ── MESSAGE EDIT ──────────────────────────────────────
client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  const embed = new EmbedBuilder()
    .setColor(0xffb700)
    .setAuthor({name:(newMsg.author?.username||'unknown')+' — edited message', iconURL:newMsg.author?.displayAvatarURL()||undefined})
    .setTitle('✏️ message edited')
    .addFields(
      { name:'👤 author',  value:'<@'+newMsg.author?.id+'>', inline:true },
      { name:'📺 channel', value:'<#'+newMsg.channel.id+'>', inline:true },
      { name:'🔗 jump',    value:'[click here]('+newMsg.url+')', inline:true },
      { name:'❌ before', value:'```\n'+(oldMsg.content||'*not cached*').slice(0,500)+'\n```' },
      { name:'✅ after',  value:'```\n'+(newMsg.content||'').slice(0,500)+'\n```' },
    )
    .setFooter({text:'user id: '+newMsg.author?.id})
    .setTimestamp();
  await sendAuditLog(newMsg.guild,'editedMessages',embed);
  addLog('EDIT',newMsg.author?.username+' edited a message in #'+newMsg.channel.name,'yellow',`user: ${newMsg.author?.username} (${newMsg.author?.id})\nchannel: #${newMsg.channel.name}\nBEFORE: ${oldMsg.content||'?'}\nAFTER: ${newMsg.content||''}`);
});

// ── ROLE CHANGES ──────────────────────────────────────
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  const added   = newMember.roles.cache.filter(r=>!oldMember.roles.cache.has(r.id));
  const removed = oldMember.roles.cache.filter(r=>!newMember.roles.cache.has(r.id));
  if (!added.size && !removed.size) return;
  const embed = new EmbedBuilder().setColor(0x9b8cff).setAuthor({name:newMember.user.username+' — roles updated',iconURL:newMember.user.displayAvatarURL()}).setTitle('🏷️ roles changed').setThumbnail(newMember.user.displayAvatarURL()).setFooter({text:newMember.guild.name}).setTimestamp();
  if (added.size)   embed.addFields({name:'✅ added',value:added.map(r=>'<@&'+r.id+'>').join(', ')});
  if (removed.size) embed.addFields({name:'❌ removed',value:removed.map(r=>'<@&'+r.id+'>').join(', ')});
  embed.addFields({name:'👤 user',value:'<@'+newMember.id+'>',inline:true},{name:'🆔 user id',value:newMember.id,inline:true});
  await sendAuditLog(newMember.guild,'roleChanges',embed);
  addLog('ROLE',newMember.user.username+' roles changed','purple');
});

// ── VOICE ACTIVITY LOG ────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  // ── LOG ──────────────────────────────────────────────
  if (!newState.member?.user?.bot) {
    const member = newState.member || oldState.member;
    if (member) {
      let action, color;
      if (!oldState.channelId && newState.channelId)        { action='🎤 joined <#'+newState.channelId+'>'; color=0x00e87a; }
      else if (oldState.channelId && !newState.channelId)   { action='🔇 left <#'+oldState.channelId+'>'; color=0xff3555; }
      else if (oldState.channelId!==newState.channelId)     { action='🔀 moved from <#'+oldState.channelId+'> to <#'+newState.channelId+'>'; color=0xffb700; }
      if (action) {
        const embed=new EmbedBuilder().setColor(color).setAuthor({name:member.user.username,iconURL:member.user.displayAvatarURL()}).setTitle('🎙️ voice activity').setDescription(action).addFields({name:'👤 user',value:'<@'+member.id+'>',inline:true},{name:'🆔 user id',value:member.id,inline:true}).setThumbnail(member.user.displayAvatarURL()).setFooter({text:newState.guild.name}).setTimestamp();
        sendAuditLog(newState.guild,'voiceActivity',embed);
        addLog('VOICE',member.user.username+' '+action.replace(/<#[0-9]+>/g,''),'blue');
      }
    }
  }

  // ── TEMP VOICE CREATE ────────────────────────────────
  if (!state.tempVoiceEnabled) return;
  const cfg = tvCfg(newState.guild?.id || '');
  if (!cfg.creatorId) return;

  if (newState.channelId === cfg.creatorId) {
    const guild  = newState.guild;
    const member = newState.member;
    try {
      const newCh = await guild.channels.create({
        name:'🔊 '+member.displayName,
        type:2,
        parent:cfg.categoryId||undefined,
        permissionOverwrites:[
          { id:guild.id,   allow:[PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel] },
          { id:member.id,  allow:[PermissionFlagsBits.ManageChannels, PermissionFlagsBits.MoveMembers, PermissionFlagsBits.MuteMembers, PermissionFlagsBits.DeafenMembers, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak, PermissionFlagsBits.ViewChannel] },
        ]
      });
      state.tempVoiceChannels[newCh.id] = {
        ownerId:member.id, guildId:guild.id, name:newCh.name,
        limit:0, locked:false, hidden:false, region:null,
        trustedUsers:[], bannedUsers:[], controlMsgId:null,
      };
      await member.voice.setChannel(newCh);
      await tvSendPanel(guild, newCh.id);
      addLog('VOICE',member.user.username+' created temp vc','cyan');
    } catch(e) { console.error('create vc err:', e.message); addLog('VOICE','create failed: '+e.message,'red'); }
    return;
  }

  // ── TEMP VOICE DELETE WHEN EMPTY ─────────────────────
  if (oldState.channelId && state.tempVoiceChannels[oldState.channelId]) {
    const guild  = oldState.guild;
    const ch     = guild.channels.cache.get(oldState.channelId);
    const chData = state.tempVoiceChannels[oldState.channelId];
    if (ch && ch.members.size === 0) {
      if (chData.controlMsgId && cfg.controlChannelId) {
        const ctrl = guild.channels.cache.get(cfg.controlChannelId);
        if (ctrl) ctrl.messages.fetch(chData.controlMsgId).then(m=>m.delete()).catch(()=>{});
      }
      delete state.tempVoiceChannels[oldState.channelId];
      await ch.delete().catch(()=>{});
      addLog('VOICE','temp vc deleted (empty)','yellow');
    } else if (ch && chData.ownerId === oldState.member?.id && ch.members.size > 0) {
      const newOwner = ch.members.first();
      chData.ownerId = newOwner.id;
      chData.name    = '🔊 '+newOwner.displayName;
      await ch.setName(chData.name).catch(()=>{});
      await tvUpdatePanel(guild, oldState.channelId);
      addLog('VOICE','vc ownership transferred to '+newOwner.user.username,'blue');
    }
  }
});

// ── TEMP VOICE BUTTONS ────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;
  if (!customId.startsWith('tv_')) return;
  const parts = customId.split('_');
  const action = parts[1];
  const channelId = parts[2];
  const chData = state.tempVoiceChannels[channelId];
  const guild  = interaction.guild;
  const vc     = guild?.channels.cache.get(channelId);

  if (action === 'claim') {
    if (!chData) return interaction.reply({content:'❌ channel not found',ephemeral:true});
    if (vc?.members.has(chData.ownerId)) return interaction.reply({content:'❌ owner is still in the channel',ephemeral:true});
    chData.ownerId = interaction.user.id;
    await tvUpdatePanel(guild, channelId);
    return interaction.reply({content:'👑 you are now the owner',ephemeral:true});
  }

  if (!chData) return interaction.reply({content:'❌ channel not found or already deleted',ephemeral:true});
  if (chData.ownerId !== interaction.user.id) return interaction.reply({content:'❌ only the channel owner can use these controls',ephemeral:true});

  async function ask(prompt) {
    await interaction.reply({content:prompt,ephemeral:true});
    const col = interaction.channel.createMessageCollector({filter:m=>m.author.id===interaction.user.id,time:30000,max:1});
    return new Promise(res => {
      col.on('collect', async m => { await m.delete().catch(()=>{}); res(m.content.trim()); });
      col.on('end', c => { if (!c.size) res(null); });
    });
  }

  try {
    if (action==='name') {
      const n = await ask('✏️ type the new name for your channel (30 seconds):');
      if (!n) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const name = '🔊 '+n.slice(0,95);
      await vc?.setName(name); chData.name=name;
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'✅ renamed to **'+name+'**',ephemeral:true});
    }
    else if (action==='limit') {
      const n = await ask('👥 type the user limit (0 = unlimited, max 99):');
      if (n===null) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const lim = Math.min(99,Math.max(0,parseInt(n)||0));
      await vc?.setUserLimit(lim); chData.limit=lim;
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'✅ limit: **'+(lim||'unlimited')+'**',ephemeral:true});
    }
    else if (action==='privacy') {
      await interaction.reply({content:'🔒 choose privacy:',ephemeral:true,components:[{type:1,components:[
        {type:2,style:2,label:'Lock (no join)',emoji:'🔒',custom_id:'tv_lock_'+channelId},
        {type:2,style:2,label:'Hide (invisible)',emoji:'👁️',custom_id:'tv_hide_'+channelId},
        {type:2,style:1,label:'Unlock & Show',emoji:'🔓',custom_id:'tv_unlock_'+channelId},
      ]}]});
    }
    else if (action==='lock') {
      chData.locked=true; await vc?.permissionOverwrites.edit(guild.id,{Connect:false});
      await tvUpdatePanel(guild,channelId); interaction.reply({content:'🔒 channel locked',ephemeral:true});
    }
    else if (action==='hide') {
      chData.hidden=true; await vc?.permissionOverwrites.edit(guild.id,{ViewChannel:false,Connect:false});
      await tvUpdatePanel(guild,channelId); interaction.reply({content:'👁️ channel hidden',ephemeral:true});
    }
    else if (action==='unlock') {
      chData.locked=false; chData.hidden=false;
      await vc?.permissionOverwrites.edit(guild.id,{ViewChannel:true,Connect:true});
      await tvUpdatePanel(guild,channelId); interaction.reply({content:'🔓 channel unlocked and visible',ephemeral:true});
    }
    else if (action==='region') {
      await interaction.reply({content:'🌐 select region:',ephemeral:true,components:[{type:1,components:[{type:3,custom_id:'tv_setregion_'+channelId,placeholder:'choose region',options:[
        {label:'Automatic',value:'',default:!chData.region},
        {label:'🇺🇸 US East',value:'us-east'},{label:'🇺🇸 US West',value:'us-west'},
        {label:'🇺🇸 US Central',value:'us-central'},{label:'🇺🇸 US South',value:'us-south'},
        {label:'🇪🇺 Europe',value:'europe'},{label:'🇧🇷 Brazil',value:'brazil'},
        {label:'🇸🇬 Singapore',value:'singapore'},{label:'🇦🇺 Sydney',value:'sydney'},
        {label:'🇯🇵 Japan',value:'japan'},{label:'🇮🇳 India',value:'india'},
        {label:'🇩🇪 Frankfurt',value:'frankfurt'},{label:'🇬🇧 London',value:'london'},
      ]}]}]});
    }
    else if (action==='chat') {
      interaction.reply({content:'💬 use this channel to text chat with your VC members!',ephemeral:true});
    }
    else if (action==='trust') {
      const inp = await ask('🤝 type user ID or @mention to trust:');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      const t=guild.members.cache.get(tid);
      if (!t) return interaction.followUp({content:'❌ user not found',ephemeral:true});
      await vc?.permissionOverwrites.edit(tid,{Connect:true,ViewChannel:true,Speak:true});
      if (!chData.trustedUsers.includes(tid)) chData.trustedUsers.push(tid);
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'🤝 trusted **'+t.user.username+'**',ephemeral:true});
    }
    else if (action==='untrust') {
      const inp = await ask('💔 type user ID or @mention to untrust:');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      await vc?.permissionOverwrites.delete(tid).catch(()=>{});
      chData.trustedUsers=chData.trustedUsers.filter(i=>i!==tid);
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'💔 untrusted',ephemeral:true});
    }
    else if (action==='invite') {
      const inp = await ask('📨 type user ID or @mention to invite:');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      const t=guild.members.cache.get(tid);
      if (!t) return interaction.followUp({content:'❌ user not found',ephemeral:true});
      await vc?.permissionOverwrites.edit(tid,{Connect:true,ViewChannel:true});
      t.send('📨 **'+interaction.user.username+'** invited you to **'+chData.name+'** in **'+guild.name+'**!').catch(()=>{});
      interaction.followUp({content:'📨 invited **'+t.user.username+'**',ephemeral:true});
    }
    else if (action==='kick') {
      const inp = await ask('👟 type user ID or @mention to kick:');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      const t=guild.members.cache.get(tid);
      if (!t) return interaction.followUp({content:'❌ user not found',ephemeral:true});
      if (t.voice?.channelId!==channelId) return interaction.followUp({content:'❌ that user is not in your channel',ephemeral:true});
      await t.voice.disconnect();
      await vc?.permissionOverwrites.edit(tid,{Connect:false});
      interaction.followUp({content:'👟 kicked **'+t.user.username+'**',ephemeral:true});
    }
    else if (action==='wait') {
      chData.locked=!chData.locked;
      await vc?.permissionOverwrites.edit(guild.id,{Connect:!chData.locked});
      await tvUpdatePanel(guild,channelId);
      interaction.reply({content:chData.locked?'⏳ waiting room enabled':'✅ waiting room disabled',ephemeral:true});
    }
    else if (action==='block') {
      const inp = await ask('🚫 type user ID or @mention to block:');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      const t=guild.members.cache.get(tid);
      if (!t) return interaction.followUp({content:'❌ user not found',ephemeral:true});
      await vc?.permissionOverwrites.edit(tid,{Connect:false,ViewChannel:false});
      if (t.voice?.channelId===channelId) await t.voice.disconnect().catch(()=>{});
      if (!chData.bannedUsers.includes(tid)) chData.bannedUsers.push(tid);
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'🚫 blocked **'+t.user.username+'**',ephemeral:true});
    }
    else if (action==='unblock') {
      const inp = await ask('✅ type user ID or @mention to unblock:');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      await vc?.permissionOverwrites.delete(tid).catch(()=>{});
      chData.bannedUsers=chData.bannedUsers.filter(i=>i!==tid);
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'✅ unblocked',ephemeral:true});
    }
    else if (action==='transfer') {
      const inp = await ask('🔄 type user ID or @mention to transfer to (must be in your vc):');
      if (!inp) return interaction.followUp({content:'⏱️ timed out',ephemeral:true});
      const tid=inp.replace(/[<@!>]/g,'').trim();
      const t=guild.members.cache.get(tid);
      if (!t) return interaction.followUp({content:'❌ user not found',ephemeral:true});
      if (t.voice?.channelId!==channelId) return interaction.followUp({content:'❌ must be in your vc',ephemeral:true});
      await vc?.permissionOverwrites.edit(tid,{ManageChannels:true,MoveMembers:true,MuteMembers:true,DeafenMembers:true,Connect:true,Speak:true,ViewChannel:true});
      await vc?.permissionOverwrites.edit(interaction.user.id,{ManageChannels:null,MoveMembers:null});
      chData.ownerId=tid;
      await tvUpdatePanel(guild,channelId);
      interaction.followUp({content:'🔄 transferred to **'+t.user.username+'**',ephemeral:true});
    }
    else if (action==='delete') {
      const cfg2=tvCfg(guild.id);
      if (chData.controlMsgId && cfg2.controlChannelId) {
        const ctrl=guild.channels.cache.get(cfg2.controlChannelId);
        if (ctrl) ctrl.messages.fetch(chData.controlMsgId).then(m=>m.delete()).catch(()=>{});
      }
      delete state.tempVoiceChannels[channelId];
      if (vc) await vc.delete().catch(()=>{});
      interaction.reply({content:'🗑️ your channel has been deleted',ephemeral:true});
    }
  } catch(e) {
    console.error('tv btn err:', e.message);
    const p={content:'❌ error: '+e.message,ephemeral:true};
    if (interaction.replied||interaction.deferred) interaction.followUp(p).catch(()=>{});
    else interaction.reply(p).catch(()=>{});
  }
});

// ── REGION SELECT ─────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isStringSelectMenu()) return;
  if (!interaction.customId.startsWith('tv_setregion_')) return;
  const channelId = interaction.customId.replace('tv_setregion_','');
  const ch = state.tempVoiceChannels[channelId];
  if (!ch || ch.ownerId!==interaction.user.id) return interaction.reply({content:'❌ not your channel',ephemeral:true});
  const region = interaction.values[0]||null;
  const vc = interaction.guild?.channels.cache.get(channelId);
  if (vc) await vc.setRTCRegion(region).catch(()=>{});
  ch.region=region;
  await tvUpdatePanel(interaction.guild, channelId);
  interaction.reply({content:'🌐 region: **'+(region||'automatic')+'**',ephemeral:true});
});

// ── REACTION VERIFICATION ─────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot || !state.verificationEnabled || !state.verifyMessageId) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch(e) { return; } }
  if (reaction.message.id !== state.verifyMessageId) return;
  if (reaction.emoji.name !== state.verifyEmoji) { await reaction.users.remove(user.id).catch(()=>{}); return; }
  try {
    const guild  = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    if (state.verifiedRoleId)   await member.roles.add(state.verifiedRoleId).catch(()=>{});
    if (state.unverifiedRoleId) await member.roles.remove(state.unverifiedRoleId).catch(()=>{});
    await reaction.users.remove(user.id).catch(()=>{});
    user.send('✅ you have been verified in **'+guild.name+'**! welcome.').catch(()=>{});
    addLog('VERIFY',member.user.username+' verified via reaction','green');
  } catch(e) { addLog('VERIFY','verify failed: '+e.message,'red'); }
});

// ── SLASH COMMAND HANDLER ─────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  // log command
  sendAuditLog(interaction.guild,'commands',new EmbedBuilder().setColor(0x4488ff).setAuthor({name:interaction.user.username,iconURL:interaction.user.displayAvatarURL()}).setTitle('⌨️ command used').addFields({name:'💬 command',value:'`/'+cmd+'`',inline:true},{name:'👤 user',value:'<@'+interaction.user.id+'>',inline:true},{name:'📺 channel',value:'<#'+interaction.channel.id+'>',inline:true}).setFooter({text:'user id: '+interaction.user.id}).setTimestamp());

  try {
    if (cmd==='ban') {
      const user=interaction.options.getUser('user'),reason=interaction.options.getString('reason')||'no reason';
      const member=await interaction.guild.members.fetch(user.id);
      await member.ban({reason});
      addInfraction(user.username,'ban',reason);
      sendAuditLog(interaction.guild,'modActions',new EmbedBuilder().setColor(0xff3555).setTitle('🔨 member banned').addFields({name:'👤 target',value:`<@${user.id}>`,inline:true},{name:'👮 mod',value:`<@${interaction.user.id}>`,inline:true},{name:'📋 reason',value:reason}).setFooter({text:'user id: '+user.id}).setTimestamp());
      addLog('MOD',user.username+' was banned — '+reason,'red',`target: ${user.username} (${user.id})\nmod: ${interaction.user.username}\nreason: ${reason}`);
      await interaction.reply({embeds:[makeEmbed(0xff0000,'🔨 banned','**'+user.username+'** was banned.\n**reason:** '+reason)]});
    }
    else if (cmd==='kick') {
      const user=interaction.options.getUser('user'),reason=interaction.options.getString('reason')||'no reason';
      const member=await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      addInfraction(user.username,'kick',reason);
      sendAuditLog(interaction.guild,'modActions',new EmbedBuilder().setColor(0xff8800).setTitle('👟 member kicked').addFields({name:'👤 target',value:`<@${user.id}>`,inline:true},{name:'👮 mod',value:`<@${interaction.user.id}>`,inline:true},{name:'📋 reason',value:reason}).setTimestamp());
      addLog('MOD',user.username+' was kicked','red',`target: ${user.username} (${user.id})\nmod: ${interaction.user.username}\nreason: ${reason}`);
      await interaction.reply({embeds:[makeEmbed(0xff4400,'👟 kicked','**'+user.username+'** was kicked.\n**reason:** '+reason)]});
    }
    else if (cmd==='warn') {
      const user=interaction.options.getUser('user'),reason=interaction.options.getString('reason')||'no reason';
      const count=addWarning(interaction.guild.id,user.id);
      addInfraction(user.username,'warn',reason);
      sendAuditLog(interaction.guild,'modActions',new EmbedBuilder().setColor(0xffb700).setTitle('⚠️ member warned').addFields({name:'👤 target',value:`<@${user.id}>`,inline:true},{name:'👮 mod',value:`<@${interaction.user.id}>`,inline:true},{name:'⚠️ count',value:`${count}/${state.autobanThreshold}`,inline:true},{name:'📋 reason',value:reason}).setTimestamp());
      addLog('MOD',user.username+' warned ('+count+')','yellow',`target: ${user.username}\nmod: ${interaction.user.username}\nreason: ${reason}`);
      await interaction.reply({embeds:[makeEmbed(0xffaa00,'⚠️ warned','**'+user.username+'** warned.\n**reason:** '+reason+'\n**warnings:** '+count+'/'+state.autobanThreshold)]});
      if (count>=state.autobanThreshold) { const m=await interaction.guild.members.fetch(user.id).catch(()=>null); if(m) await m.ban({reason:'warning limit'}).catch(()=>{}); }
    }
    else if (cmd==='mute') {
      const user=interaction.options.getUser('user'),mins=interaction.options.getInteger('minutes')||state.muteMinutes,reason=interaction.options.getString('reason')||'no reason';
      const member=await interaction.guild.members.fetch(user.id);
      await member.timeout(mins*60000,reason);
      addInfraction(user.username,'timeout',reason);
      addLog('MOD',user.username+' timed out '+mins+'min','yellow');
      await interaction.reply({embeds:[makeEmbed(0x8800ff,'🔇 muted','**'+user.username+'** timed out for **'+mins+' min**.\n**reason:** '+reason)]});
    }
    else if (cmd==='unmute') {
      const user=interaction.options.getUser('user');
      const member=await interaction.guild.members.fetch(user.id);
      await member.timeout(null);
      await interaction.reply({embeds:[makeEmbed(0x00ff88,'🔊 unmuted','**'+user.username+'**\'s timeout removed.')]});
    }
    else if (cmd==='warnings') {
      const user=interaction.options.getUser('user');
      const count=getWarnings(interaction.guild.id,user.id);
      await interaction.reply({embeds:[makeEmbed(0xffaa00,'⚠️ warnings','**'+user.username+'** has **'+count+'/'+state.autobanThreshold+'** warnings.')]});
    }
    else if (cmd==='clearwarnings') {
      const user=interaction.options.getUser('user');
      clearWarnings(interaction.guild.id,user.id);
      await interaction.reply({embeds:[makeEmbed(0x00ff88,'✅ cleared','Warnings cleared for **'+user.username+'**.')]});
    }
    else if (cmd==='purge') {
      const amount=Math.min(100,Math.max(1,interaction.options.getInteger('amount')));
      const deleted=await interaction.channel.bulkDelete(amount,true);
      addLog('MOD',deleted.size+' messages purged in #'+interaction.channel.name,'yellow');
      await interaction.reply({embeds:[makeEmbed(0x00ff88,'🗑️ purged','Deleted **'+deleted.size+'** messages.')],ephemeral:true});
    }
    else if (cmd==='rank') {
      const user=interaction.options.getUser('user')||interaction.user;
      const d=getXP(user.id),needed=d.level*100,pct=Math.floor((d.xp/needed)*100);
      const filled=Math.floor((d.xp/needed)*20),bar='█'.repeat(filled)+'░'.repeat(20-filled);
      const rankPos=Object.entries(state.xpData).sort((a,b)=>b[1].level-a[1].level||b[1].xp-a[1].xp).findIndex(([id])=>id===user.id)+1;
      const tier=d.level>=50?'💎':d.level>=30?'🥇':d.level>=20?'🥈':d.level>=10?'🥉':'🌱';
      await interaction.reply({embeds:[new EmbedBuilder().setColor(0xffffff).setAuthor({name:user.username+"'s rank",iconURL:user.displayAvatarURL()}).setThumbnail(user.displayAvatarURL({size:256})).setDescription('**rank** `#'+rankPos+'` · **tier** '+tier+'\n\n**level '+d.level+'** → **level '+(d.level+1)+'**\n`'+bar+'` **'+pct+'%**').addFields({name:'⭐ level',value:'`'+d.level+'`',inline:true},{name:'✨ xp',value:'`'+d.xp+'/'+needed+'`',inline:true},{name:'🏆 rank',value:'`#'+rankPos+'`',inline:true}).setFooter({text:(needed-d.xp)+' xp to level up'}).setTimestamp()]});
    }
    else if (cmd==='leaderboard') {
      const sorted=Object.entries(state.xpData).sort((a,b)=>b[1].level-a[1].level||b[1].xp-a[1].xp).slice(0,10);
      const medals=['🥇','🥈','🥉','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
      const tier=l=>l>=50?'💎':l>=30?'🥇':l>=20?'🥈':l>=10?'🥉':'🌱';
      const rows=sorted.length?sorted.map(([id,d],i)=>medals[i]+' <@'+id+'> '+tier(d.level)+'\n┗ **lvl '+d.level+'** · `'+'█'.repeat(Math.floor((d.xp/(d.level*100))*10))+'░'.repeat(10-Math.floor((d.xp/(d.level*100))*10))+'` · '+(d.xp+(d.level*(d.level-1)*50)).toLocaleString()+' xp').join('\n\n'):'> no xp yet — start chatting!';
      const top=sorted[0];
      await interaction.reply({embeds:[new EmbedBuilder().setColor(0xffb700).setAuthor({name:interaction.guild.name+' — leaderboard',iconURL:interaction.guild.iconURL({dynamic:true})||undefined}).setTitle('🏆  top members').setDescription(rows).addFields({name:'👥 ranked',value:'**'+sorted.length+'**',inline:true},{name:'🌟 top level',value:top?'**'+top[1].level+'**':'—',inline:true},{name:'⚡ earn xp',value:'chat (1min cooldown)',inline:true}).setThumbnail(interaction.guild.iconURL({dynamic:true})||null).setFooter({text:'use /rank for your stats'}).setTimestamp()]});
    }
    else if (cmd==='serverinfo') {
      const g=interaction.guild;
      await interaction.reply({embeds:[new EmbedBuilder().setColor(0x111111).setTitle(g.name).setThumbnail(g.iconURL()).addFields({name:'owner',value:`<@${g.ownerId}>`,inline:true},{name:'members',value:`${g.memberCount}`,inline:true},{name:'created',value:`<t:${Math.floor(g.createdTimestamp/1000)}:R>`,inline:true},{name:'channels',value:`${g.channels.cache.size}`,inline:true},{name:'roles',value:`${g.roles.cache.size}`,inline:true},{name:'id',value:g.id,inline:true}).setTimestamp()]});
    }
    else if (cmd==='userinfo') {
      const user=interaction.options.getUser('user')||interaction.user;
      const member=await interaction.guild.members.fetch(user.id).catch(()=>null);
      const d=getXP(user.id);
      await interaction.reply({embeds:[new EmbedBuilder().setColor(0x111111).setTitle(user.username).setThumbnail(user.displayAvatarURL()).addFields({name:'id',value:user.id,inline:true},{name:'joined',value:member?`<t:${Math.floor(member.joinedTimestamp/1000)}:R>`:'—',inline:true},{name:'created',value:`<t:${Math.floor(user.createdTimestamp/1000)}:R>`,inline:true},{name:'level',value:`${d.level}`,inline:true},{name:'xp',value:`${d.xp}`,inline:true},{name:'warnings',value:`${getWarnings(interaction.guild.id,user.id)}`,inline:true}).setTimestamp()]});
    }
    else if (cmd==='ticket') {
      await openTicket(interaction.guild, interaction.user, interaction);
    }
    else if (cmd==='closeticket') {
      const ticket=state.tickets[interaction.channel.id];
      if (!ticket) return interaction.reply({content:'not a ticket channel.',ephemeral:true});
      await interaction.reply({embeds:[makeEmbed(0x111111,'🔒 closed','deleting in 5 seconds.')]});
      delete state.tickets[interaction.channel.id];
      setTimeout(()=>interaction.channel.delete().catch(()=>{}),5000);
    }
    else if (cmd==='ticketpanel') {
      const ch = interaction.options.getChannel('channel') || interaction.channel;
      const botAvatar = client.user.displayAvatarURL({ dynamic:true, size:512 });
      const panelEmbed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setAuthor({ name: 'fa11en', iconURL: botAvatar })
        .setTitle('🎫  create a ticket')
        .setDescription('> by clicking the button below, a ticket will be opened for you.\n> our staff will assist you as soon as possible.')
        .setThumbnail(botAvatar)
        .addFields(
          { name: '📋 how it works', value: '1. click **Create Ticket** below\n2. a private channel opens just for you\n3. describe your issue and wait for staff', inline: false },
        )
        .setFooter({ text: 'fa11en · support system', iconURL: botAvatar })
        .setTimestamp();
      await ch.send({
        embeds: [panelEmbed],
        components: [{ type:1, components:[
          { type:2, style:1, label:'Create Ticket', emoji:'🎫', custom_id:'open_ticket' }
        ]}]
      });
      await interaction.reply({ content: '✅ ticket panel posted in <#'+ch.id+'>', ephemeral:true });
      addLog('TICKET','ticket panel posted in #'+ch.name,'cyan');
    }
    else if (cmd==='say') {
      const msg=interaction.options.getString('message');
      await interaction.reply({content:'✅ sent',ephemeral:true});
      await interaction.channel.send(msg);
    }
    else if (cmd==='ping') {
      await interaction.reply({embeds:[makeEmbed(0x111111,'🏓 pong!','ws ping: **'+client.ws.ping+'ms**')]});
    }
    else if (cmd==='help') {
      await interaction.reply({embeds:[new EmbedBuilder().setColor(0x111111).setTitle('📖 fa11en — commands').addFields({name:'🔨 moderation',value:'`/ban` `/kick` `/warn` `/mute` `/unmute`\n`/warnings` `/clearwarnings` `/purge`'},{name:'📊 leveling',value:'`/rank` `/leaderboard`'},{name:'🎫 tickets',value:'`/ticket` `/closeticket`'},{name:'🛠️ utility',value:'`/say` `/ping` `/serverinfo` `/userinfo` `/help`'}).setFooter({text:'fa11en bot'}).setTimestamp()],ephemeral:true});
    }
  } catch(e) {
    console.error('cmd err:', e.message);
    const r={content:'❌ error: '+e.message,ephemeral:true};
    if (interaction.replied||interaction.deferred) interaction.followUp(r).catch(()=>{});
    else interaction.reply(r).catch(()=>{});
  }
});

// ── TICKET SYSTEM ────────────────────────────────────
async function openTicket(guild, user, interaction) {
  if (!state.ticketsEnabled) {
    const r = { content:'❌ tickets are disabled', ephemeral:true };
    if (interaction.replied||interaction.deferred) return interaction.followUp(r);
    return interaction.reply(r);
  }
  // check if user already has a ticket open
  const existing = Object.entries(state.tickets).find(([,t])=>t.userId===user.id);
  if (existing) {
    const r = { content:'❌ you already have a ticket open: <#'+existing[0]+'>', ephemeral:true };
    if (interaction.replied||interaction.deferred) return interaction.followUp(r);
    return interaction.reply(r);
  }
  state.ticketCount++;
  const num = String(state.ticketCount).padStart(4,'0');
  const botAvatar = client.user.displayAvatarURL({ dynamic:true, size:512 });

  // find or create ticket category
  let category = guild.channels.cache.find(c=>c.type===4 && c.name.toLowerCase().includes('ticket'));

  const ch = await guild.channels.create({
    name: 'ticket-'+num,
    type: 0,
    parent: category?.id || undefined,
    permissionOverwrites: [
      { id: guild.id,  deny:  [PermissionFlagsBits.ViewChannel] },
      { id: user.id,   allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ]
  });

  state.tickets[ch.id] = { userId: user.id, ticketNum: num, opened: new Date().toISOString() };
  saveState();

  const ticketEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: 'fa11en support', iconURL: botAvatar })
    .setTitle('Ticket #' + num)
    .setDescription('Hey <@'+user.id+'>, thanks for reaching out!\n\n**Additional Information:**\n> \u2726 A staff member will be with you shortly.\n> \u2726 Please describe your issue clearly.\n> \u2726 If it\'s urgent, mention a staff member.')
    .setThumbnail(user.displayAvatarURL({ dynamic:true, size:256 }))
    .addFields(
      { name: '👤 opened by', value: '<@'+user.id+'>', inline: true },
      { name: '🕐 opened at', value: '<t:'+Math.floor(Date.now()/1000)+':R>', inline: true },
      { name: '🆔 ticket',    value: '#'+num, inline: true },
    )
    .setFooter({ text: 'fa11en · use the button below to close', iconURL: botAvatar })
    .setTimestamp();

  await ch.send({
    content: '<@'+user.id+'>',
    embeds: [ticketEmbed],
    components: [{ type:1, components:[
      { type:2, style:4, label:'Close Ticket', emoji:'🔒', custom_id:'close_ticket' }
    ]}]
  });

  addLog('TICKET', user.username+' opened ticket #'+num, 'cyan');

  const r = { content:'✅ ticket opened: <#'+ch.id+'>', ephemeral:true };
  if (interaction.replied||interaction.deferred) interaction.followUp(r).catch(()=>{});
  else interaction.reply(r).catch(()=>{});
}

// ticket button handler
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // open ticket button (from panel)
  if (interaction.customId === 'open_ticket') {
    await openTicket(interaction.guild, interaction.user, interaction);
    return;
  }

  // close ticket button (inside ticket channel)
  if (interaction.customId === 'close_ticket') {
    const ticket = state.tickets[interaction.channel.id];
    if (!ticket) return interaction.reply({ content:'❌ not a ticket channel', ephemeral:true });
    const botAvatar = client.user.displayAvatarURL({ dynamic:true, size:512 });
    await interaction.reply({ embeds:[new EmbedBuilder()
      .setColor(0xff3555)
      .setAuthor({ name:'fa11en support', iconURL:botAvatar })
      .setTitle('🔒 ticket closed')
      .setDescription('> this ticket will be deleted in **5 seconds**.')
      .setFooter({ text:'closed by '+interaction.user.username })
      .setTimestamp()
    ]});
    addLog('TICKET','ticket #'+ticket.ticketNum+' closed by '+interaction.user.username,'yellow');
    delete state.tickets[interaction.channel.id];
    saveState();
    setTimeout(()=>interaction.channel.delete().catch(()=>{}), 5000);
  }
});

// ── VERIFICATION HELPERS ──────────────────────────────
function createVerifyToken(userId, guildId) {
  const token=Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);
  state.pendingVerifications[token]={ userId, guildId, roleId:state.verifiedRoleId, expires:Date.now()+15*60*1000 };
  return token;
}
async function completeVerification(token) {
  const data=state.pendingVerifications[token];
  if (!data) return {ok:false,error:'invalid or expired token'};
  if (Date.now()>data.expires) { delete state.pendingVerifications[token]; return {ok:false,error:'token expired — click verify again'}; }
  const roleId=state.verifiedRoleId||data.roleId;
  if (!roleId) return {ok:false,error:'verified role not set in dashboard'};
  try {
    const guild=client.guilds.cache.get(data.guildId);
    if (!guild) return {ok:false,error:'bot not in that server'};
    const member=await guild.members.fetch(data.userId).catch(()=>null);
    if (!member) return {ok:false,error:'could not find you in the server'};
    await member.roles.add(roleId);
    delete state.pendingVerifications[token];
    addLog('VERIFY',member.user.username+' verified','green');
    return {ok:true,username:member.user.username};
  } catch(e) {
    return {ok:false,error:e.message.includes('Missing Permissions')?'bot missing permissions — put bot role above verified role':e.message};
  }
}
setInterval(()=>{ const now=Date.now(); Object.keys(state.pendingVerifications).forEach(t=>{ if(state.pendingVerifications[t].expires<now) delete state.pendingVerifications[t]; }); }, 5*60*1000);

client.login(TOKEN).catch(e=>console.error('❌ login failed:',e.message));

module.exports = { client, state, addLog, addWarning, getWarnings, clearWarnings, addInfraction, createVerifyToken, completeVerification, saveState };
