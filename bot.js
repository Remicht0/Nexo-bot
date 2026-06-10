require("dotenv").config();

const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");
const { Telegraf, Markup } = require("telegraf");

const TOKEN = process.env.BOT_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const SHOP_NAME = process.env.SHOP_NAME || "NEXO MARKET";
const PAYPAL_LINK = process.env.PAYPAL_LINK || "https://paypal.me/TONPAYPAL";

const MEMBER_ROLE_NAME = process.env.MEMBER_ROLE_NAME || "👤 Membre";
const CLIENT_ROLE_NAME = process.env.CLIENT_ROLE_NAME || "✅ Client";
const STAFF_ROLE_NAME = process.env.STAFF_ROLE_NAME || "🔧 Staff";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID || "";

const PUB_MESSAGE = `**NEXO MARKET** ⚡

Nouveau serveur digital / bons plans / services tech.

🛒 Offres courses
🍗 Restauration
🚆 Transport
🎴 Pokémon
🤖 IA / Discord / automatisation
🔥 Promos & arrivages réguliers

🎫 Commandes via tickets privés
⭐ Avis clients
🔒 Vérification membre
🎁 -5% avec le code **NEXO5**

https://discord.gg/RMGBZFWZXp`;

const PUB_SERVERS = {
  sushi: {
    label: "🍣 Ze Sushi Pub — pub rapides",
    serverId: "777371615184551966",
    channelId: "836546525520723978",
    cooldownMs: 2 * 60 * 60 * 1000,
  },
  drop: {
    label: "📢 Drop Ta Pub — pub rapide",
    serverId: "733072297430089758",
    channelId: "1456313127712067645",
    cooldownMs: 2 * 60 * 60 * 1000,
  },
};

const pubCooldowns = {};


if (!TOKEN || !GUILD_ID) {
  console.error("❌ BOT_TOKEN ou GUILD_ID manquant dans .env");
  process.exit(1);
}

const discord = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

let telegram = null;
let guildCache = null;
const pending = new Map();

// ===== BUMP REMINDER SYSTEM =====
let bumpReminderActive = false;
let bumpReminderTimer = null;
let bumpReminderChatId = null;
const BUMP_DELAY_MS = 2 * 60 * 60 * 1000; // 2h

function clearBumpReminder() {
  if (bumpReminderTimer) {
    clearTimeout(bumpReminderTimer);
    bumpReminderTimer = null;
  }
}

function scheduleBumpReminder(chatId, delayMs = BUMP_DELAY_MS) {
  clearBumpReminder();
  bumpReminderActive = true;
  bumpReminderChatId = chatId;

  bumpReminderTimer = setTimeout(async () => {
    if (!telegram || !bumpReminderActive || !bumpReminderChatId) return;

    await telegram.telegram.sendMessage(
      bumpReminderChatId,
      "🔔 C’est l’heure de bump Disboard !\n\nVa dans ton salon bump sur Discord et fais `/bump`.\nQuand c’est fait, clique sur ✅ Bump fait.",
      Markup.inlineKeyboard([
        [Markup.button.callback("✅ Bump fait", "bump:done")],
        [Markup.button.callback("⏰ Me rappeler dans 15 min", "bump:snooze")],
        [Markup.button.callback("⏸️ Pause rappels", "bump:pause")],
      ])
    ).catch((err) => console.error("❌ Erreur rappel bump:", err));
  }, delayMs);
}


const cachePath = path.join(__dirname, "stock-cache.json");

// ===== VFINAL DATA SYSTEM =====
const vDataPath = path.join(__dirname, "nexo-data.json");
const defaultVData = {
  counters: { ticketsOpened: 0, ticketsClosed: 0, ordersDelivered: 0, reviews: 0, pubsPosted: 0 },
  tickets: {},
  clients: {},
  locked: false,
};

function loadVData() {
  try {
    if (!fs.existsSync(vDataPath)) return structuredClone(defaultVData);
    return { ...structuredClone(defaultVData), ...JSON.parse(fs.readFileSync(vDataPath, "utf8")) };
  } catch (e) {
    console.error("⚠️ nexo-data.json illisible:", e);
    return structuredClone(defaultVData);
  }
}

let vData = loadVData();

function saveVData() {
  fs.writeFileSync(vDataPath, JSON.stringify(vData, null, 2), "utf8");
}

function ensureClient(userId, username = "inconnu") {
  if (!vData.clients[userId]) vData.clients[userId] = { username, orders: 0, delivered: 0, reviews: 0, lastOrder: "", createdAt: Date.now() };
  if (username) vData.clients[userId].username = username;
  saveVData();
  return vData.clients[userId];
}

function orderStatusRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("order_validated").setLabel("✅ Validée").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("order_paid").setLabel("💳 Payée").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("order_progress").setLabel("📦 En cours").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("order_delivered").setLabel("✅ Livrée").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("order_problem").setLabel("⚠️ Problème").setStyle(ButtonStyle.Danger)
  );
}

async function setTicketStatus(interaction, status) {
  const t = vData.tickets[interaction.channel.id] || null;
  if (t) {
    t.status = status;
    t.updatedAt = Date.now();
    if (status === "livrée") {
      vData.counters.ordersDelivered += 1;
      const c = ensureClient(t.userId, t.username);
      c.orders += 1;
      c.delivered += 1;
      c.lastOrder = t.offer || t.type || "commande";
      const clientRole = interaction.guild.roles.cache.find((r) => r.name === CLIENT_ROLE_NAME);
      const m = await interaction.guild.members.fetch(t.userId).catch(() => null);
      if (clientRole && m) await m.roles.add(clientRole).catch(() => {});
    }
    saveVData();
  }
  const messages = {
    "validée": "✅ Commande validée par le staff. Attends le prix final avant paiement.",
    "payée": "💳 Paiement noté. Le staff prépare la suite.",
    "en cours": "📦 Commande en cours de traitement.",
    "livrée": "✅ Commande livrée. Merci de laisser un avis dans ⭐・avis-clients.",
    "problème": "⚠️ Problème noté. Le staff va vérifier les preuves et revenir vers toi.",
  };
  return interaction.reply({ embeds: [E("📌 Statut commande", messages[status] || status, 0x5865f2)] });
}

async function lockServer() {
  const guild = await refreshGuild();
  const member = guild.roles.cache.find((r) => r.name === MEMBER_ROLE_NAME);
  if (!member) throw new Error("Rôle membre introuvable");
  for (const name of ["💬・discussion", "❓・questions", "⚠️・problèmes-litiges", "🤝・partenariats"]) {
    const ch = guild.channels.cache.find((c) => c.name === name && c.isTextBased());
    if (ch) await ch.permissionOverwrites.edit(member.id, { SendMessages: false }).catch(() => {});
  }
  vData.locked = true; saveVData();
}

async function unlockServer() {
  const guild = await refreshGuild();
  const member = guild.roles.cache.find((r) => r.name === MEMBER_ROLE_NAME);
  if (!member) throw new Error("Rôle membre introuvable");
  for (const name of ["💬・discussion", "❓・questions", "⚠️・problèmes-litiges", "🤝・partenariats"]) {
    const ch = guild.channels.cache.find((c) => c.name === name && c.isTextBased());
    if (ch) await ch.permissionOverwrites.edit(member.id, { SendMessages: true }).catch(() => {});
  }
  vData.locked = false; saveVData();
}

function vStatsText(guild) {
  const open = Object.values(vData.tickets).filter(t => t.status !== "fermé").length;
  return [
    `**Membres :** ${guild.memberCount || "?"}`,
    `**Tickets ouverts :** ${open}`,
    `**Tickets créés :** ${vData.counters.ticketsOpened}`,
    `**Tickets fermés :** ${vData.counters.ticketsClosed}`,
    `**Commandes livrées :** ${vData.counters.ordersDelivered}`,
    `**Clients suivis :** ${Object.keys(vData.clients).length}`,
    `**Avis :** ${vData.counters.reviews}`,
    `**Pubs notées :** ${vData.counters.pubsPosted}`,
    `**Sécurité :** ${vData.locked ? "🔒 LOCK" : "🔓 ouvert"}`,
  ].join("\n");
}


const stockState = {
  tech16: {
    label: "💸 Tech 16",
    status: "🎫 à vérifier en ticket",
    price: "34,99€",
    note: "Offre disponible selon conditions du moment.",
  },
  sncf: {
    label: "🚆 SNCF",
    status: "🎫 à vérifier en ticket",
    price: "29,99€",
    note: "Offres transport disponibles en ticket selon stock et conditions.",
  },
  carrefourProvider: {
    label: "🛒 Fournisseur Carrefour",
    status: "🎫 à vérifier en ticket",
    price: "59,99€",
    note: "Offres courses remisées et accès fournisseur selon disponibilité.",
  },
  carrefourOrders: {
    label: "🛍️ Commandes Carrefour remisées",
    status: "🎫 selon panier",
    price: "prix du panier remisé + commission",
    note: "-40% à -60%, parfois -70% selon produits disponibles.",
  },
  kfc: {
    label: "🍗 KFC",
    status: "🎫 selon stock disponible",
    price: "selon points",
    note: "Offres selon stock disponible.",
  },
  pokemon: {
    label: "🎴 Pokémon",
    status: "🎫 selon arrivage",
    price: "selon stock et marché",
    note: "Cartes, boosters, lots, items.",
  },
  ia: {
    label: "🤖 IA / Services tech",
    status: "✅ disponible",
    price: "sur devis",
    note: "IA, Discord, bot, automatisation.",
  },
};

function readCache() {
  try {
    if (!fs.existsSync(cachePath)) return { stockMessages: {} };
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return { stockMessages: {} };
  }
}

function writeCache(cache) {
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

function E(title, description, color = 0x111111) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setFooter({ text: SHOP_NAME })
    .setTimestamp();
}

function stockEmbed(key) {
  const item = stockState[key];
  return E(item.label, [
    `**Statut :** ${item.status}`,
    `**Prix :** ${item.price}`,
    item.note ? `**Infos :** ${item.note}` : "",
    "",
    "🎫 Stock et prix final confirmés en ticket.",
  ].filter(Boolean).join("\n"), statusColor(item.status));
}

function statusColor(status) {
  if (status.includes("✅")) return 0x2ecc71;
  if (status.includes("⚠️")) return 0xf1c40f;
  if (status.includes("❌")) return 0xe74c3c;
  return 0x5865f2;
}

async function getGuild() {
  if (!guildCache) {
    guildCache = await discord.guilds.fetch(GUILD_ID);
    await guildCache.channels.fetch();
    await guildCache.roles.fetch();
  }
  return guildCache;
}

async function refreshGuild() {
  const guild = await getGuild();
  await guild.channels.fetch();
  await guild.roles.fetch();
  return guild;
}

async function findTextChannel(name) {
  const guild = await refreshGuild();
  return guild.channels.cache.find((c) => c.name === name && c.isTextBased());
}

async function sendOrEditMessage(channel, messageId, payload) {
  if (messageId) {
    try {
      const old = await channel.messages.fetch(messageId);
      await old.edit(payload);
      return old;
    } catch {
      // message supprimé ou introuvable, on recrée
    }
  }
  return await channel.send(payload);
}

async function ensureStockDashboard() {
  const channel = await findTextChannel("📦・stock");
  if (!channel) throw new Error("Salon 📦・stock introuvable");

  const cache = readCache();
  if (!cache.stockMessages) cache.stockMessages = {};

  // Message d'intro unique
  const introPayload = {
    embeds: [E("📦・STOCK ACTUEL", [
      "Stock mis à jour automatiquement depuis Telegram.",
      "",
      "Chaque offre est séparée : quand tu modifies un statut, le bot édite uniquement la carte concernée.",
      "",
      "✅ Disponible · ⚠️ Stock limité · ❌ Indisponible · 🎫 À vérifier en ticket",
    ].join("\n"))],
  };

  const intro = await sendOrEditMessage(channel, cache.stockIntro, introPayload);
  cache.stockIntro = intro.id;

  // Une carte Discord par offre
  for (const key of Object.keys(stockState)) {
    const msg = await sendOrEditMessage(channel, cache.stockMessages[key], {
      embeds: [stockEmbed(key)],
    });
    cache.stockMessages[key] = msg.id;
  }

  writeCache(cache);
  return true;
}

async function updateOneStockCard(key) {
  const channel = await findTextChannel("📦・stock");
  if (!channel) throw new Error("Salon 📦・stock introuvable");

  const cache = readCache();
  if (!cache.stockMessages) cache.stockMessages = {};

  const msg = await sendOrEditMessage(channel, cache.stockMessages[key], {
    embeds: [stockEmbed(key)],
  });

  cache.stockMessages[key] = msg.id;
  writeCache(cache);
}

async function updatePricePanel() {
  const channel = await findTextChannel("💸・prix");
  if (!channel) throw new Error("Salon 💸・prix introuvable");

  const cache = readCache();

  const txt = [
    "## 💸・TECHNIQUES & FOURNISSEURS",
    `💸 **Tech 16** — ${stockState.tech16.price}`,
    `🚆 **SNCF jusqu’à -90%** — ${stockState.sncf.price}`,
    `🛒 **Fournisseur Carrefour** — ${stockState.carrefourProvider.price}`,
    "",
    "## 🛍️・COMMANDES CARREFOUR RÉDUITES",
    "Réduction moyenne : **-40% à -60%**",
    "Parfois jusqu’à **-70%** selon les produits disponibles.",
    "",
    "**Tarif : prix du panier remisé + commission**",
    "```",
    "Montant panier      Commission",
    "0€ à 30€            +4€",
    "30€ à 60€           +7€",
    "60€ à 100€          +10€",
    "100€+               +13€",
    "```",
    "",
    "## 🍗・KFC",
    "```",
    "Points              Prix",
    "600 - 799 pts       1,49€",
    "800 - 999 pts       3,49€",
    "1000 - 1299 pts     4,49€",
    "1300 - 1599 pts     5,99€",
    "1600 - 1799 pts     6,99€",
    "1800 - 1999 pts     7,99€",
    "```",
    "",
    "## 🎴・POKÉMON",
    "Prix selon arrivage, état, langue, stock et marché.",
    "",
    "## 🤖・IA & SERVICES TECH",
    "🤖 Aide IA / prompts — à partir de 4,99€",
    "🛠️ Setup Discord simple — à partir de 9,99€",
    "🎫 Installation tickets — à partir de 7,99€",
    "⚙️ Bot / automatisation — sur devis",
    "",
    "🎫 Pour commander : ouvre un ticket.",
  ].join("\n");

  const msg = await sendOrEditMessage(channel, cache.priceMessage, {
    embeds: [E("🛒・PRIX OFFICIELS", txt)],
  });

  cache.priceMessage = msg.id;
  writeCache(cache);
}

async function sendAnnouncement(title, message) {
  const channel = await findTextChannel("📢・annonces");
  if (!channel) throw new Error("Salon 📢・annonces introuvable");
  return channel.send({
    embeds: [E(title, message, 0x0099ff)],
    allowedMentions: { parse: [] },
  });
}

async function sendPromo(title, message) {
  const channel = await findTextChannel("🔥・promos");
  if (!channel) throw new Error("Salon 🔥・promos introuvable");
  return channel.send({ embeds: [E(title, message, 0xff6600)] });
}


function pubLink(key) {
  const item = PUB_SERVERS[key];
  return `https://discord.com/channels/${item.serverId}/${item.channelId}`;
}

function remainingCooldownText(key) {
  const item = PUB_SERVERS[key];
  const last = pubCooldowns[key] || 0;
  const remaining = item.cooldownMs - (Date.now() - last);

  if (remaining <= 0) return "✅ disponible maintenant";

  const mins = Math.ceil(remaining / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;

  if (h <= 0) return `⏳ encore ${m} min`;
  if (m <= 0) return `⏳ encore ${h}h`;
  return `⏳ encore ${h}h${m}`;
}

function pubMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🍣 Ze Sushi Pub — pub rapides", "pubserver:sushi")],
    [Markup.button.callback("📢 Drop Ta Pub — pub rapide", "pubserver:drop")],
    [Markup.button.callback("📋 Message seul à copier", "pub:copy")],
    [Markup.button.callback("⬅️ Menu principal", "pubmanager:main")],
  ]);
}

function pubServerKeyboard(key) {
  const link = pubLink(key);
  return Markup.inlineKeyboard([
    [Markup.button.url("📲 Ouvrir le salon Discord", link)],
    [Markup.button.callback("✅ Pub postée", `pubdone:${key}`)],
    [Markup.button.callback("⏰ Rappel dans 2h", `pubremind:${key}`)],
    [Markup.button.callback("📋 Message seul à copier", `pubcopy:${key}`)],
    [Markup.button.callback("⬅️ Retour pubs", "menu:pubmanager")],
  ]);
}

async function schedulePubReminder(ctx, key) {
  const item = PUB_SERVERS[key];
  setTimeout(async () => {
    try {
      await telegram.telegram.sendMessage(
        ctx.chat.id,
        `🔔 Cooldown terminé pour ${item.label}\n\nTu peux reposter ta pub si le règlement du serveur l’autorise.`,
        Markup.inlineKeyboard([
          [Markup.button.url("📲 Ouvrir le salon Discord", pubLink(key))],
          [Markup.button.callback("✅ Pub postée", `pubdone:${key}`)],
          [Markup.button.callback("⬅️ Menu pubs", "menu:pubmanager")],
        ])
      );
    } catch (err) {
      console.error("❌ Erreur rappel pub:", err);
    }
  }, item.cooldownMs);
}

function adminIds() {
  return String(TELEGRAM_ADMIN_ID)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function isAdmin(ctx) {
  return adminIds().includes(String(ctx.from.id));
}

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📦 Stock", "menu:stock"), Markup.button.callback("💸 Prix", "menu:price")],
    [Markup.button.callback("🎟️ Tickets", "menu:tickets"), Markup.button.callback("👤 Clients", "menu:clients")],
    [Markup.button.callback("📣 Pub", "menu:pubmanager"), Markup.button.callback("🔔 Bump", "menu:bump")],
    [Markup.button.callback("🚨 Sécurité", "menu:security"), Markup.button.callback("📊 Stats", "menu:stats")],
    [Markup.button.callback("🔄 Créer / réparer stock", "action:setupStock")],
  ]);
}

const itemKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("💸 Tech 16", "item:tech16"), Markup.button.callback("🚆 SNCF", "item:sncf")],
  [Markup.button.callback("🛒 Fournisseur Carrefour", "item:carrefourProvider")],
  [Markup.button.callback("🛍️ Commandes Carrefour", "item:carrefourOrders")],
  [Markup.button.callback("🍗 KFC", "item:kfc"), Markup.button.callback("🎴 Pokémon", "item:pokemon")],
  [Markup.button.callback("🤖 IA / Services tech", "item:ia")],
]);

function statusKeyboard(key) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Disponible", `status:${key}:✅ disponible`)],
    [Markup.button.callback("⚠️ Stock limité", `status:${key}:⚠️ stock limité`)],
    [Markup.button.callback("❌ Indisponible", `status:${key}:❌ indisponible`)],
    [Markup.button.callback("🎫 À vérifier", `status:${key}:🎫 à vérifier en ticket`)],
    [Markup.button.callback("⬅️ Retour", "menu:stock")],
  ]);
}

function startTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("❌ TELEGRAM_BOT_TOKEN absent dans .env");
    return;
  }

  telegram = new Telegraf(TELEGRAM_BOT_TOKEN);

  telegram.start(async (ctx) => {
    const id = String(ctx.from.id);
    if (!isAdmin(ctx)) {
      return ctx.reply(`Ton ID Telegram est : ${id}\n\nMets ça dans .env :\nTELEGRAM_ADMIN_ID=${id}\n\nPuis relance npm start.`);
    }

    return ctx.reply(`⚡ ${SHOP_NAME} TURBO MANAGER\n\nQue veux-tu faire ?`, mainMenu());
  });

  telegram.command("id", async (ctx) => {
    return ctx.reply(`Ton ID Telegram est : ${ctx.from.id}`);
  });

  telegram.action("menu:stock", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    return ctx.editMessageText("📦 Choisis l’offre à modifier :", itemKeyboard);
  });

  telegram.action(/^item:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    if (!stockState[key]) return ctx.answerCbQuery("Offre inconnue");
    await ctx.answerCbQuery();
    return ctx.editMessageText(`Modifier : ${stockState[key].label}\n\nStatut actuel : ${stockState[key].status}`, statusKeyboard(key));
  });

  telegram.action(/^status:([^:]+):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    const status = ctx.match[2];
    if (!stockState[key]) return ctx.answerCbQuery("Offre inconnue");

    // Réponse immédiate Telegram = plus de chargement infini
    await ctx.answerCbQuery("Mise à jour en cours...");

    try {
      stockState[key].status = status;
      await updateOneStockCard(key);

      return ctx.editMessageText(
        `✅ Mis à jour instantanément\n\n${stockState[key].label} → ${status}`,
        Markup.inlineKeyboard([
          [Markup.button.callback("📢 Annoncer ce changement", `announceStock:${key}`)],
          [Markup.button.callback("⬅️ Retour stock", "menu:stock")],
        ])
      );
    } catch (err) {
      console.error("❌ Erreur update stock:", err);
      return ctx.reply(`❌ Erreur Discord : ${err.message}`);
    }
  });

  telegram.action(/^announceStock:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    if (!stockState[key]) return ctx.answerCbQuery("Offre inconnue");

    await ctx.answerCbQuery("Annonce en cours...");
    try {
      await sendAnnouncement("📦 Mise à jour stock", `${stockState[key].label} est maintenant : **${stockState[key].status}**\n\n🎫 Ouvre un ticket pour commander.`);
      return ctx.reply("✅ Annonce envoyée dans Discord.");
    } catch (err) {
      console.error("❌ Erreur annonce:", err);
      return ctx.reply(`❌ Erreur annonce : ${err.message}`);
    }
  });

  telegram.action("action:setupStock", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery("Réparation en cours...");
    try {
      await ensureStockDashboard();
      await updatePricePanel();
      return ctx.reply("✅ Stock réparé : une carte par offre est maintenant créée dans Discord.");
    } catch (err) {
      console.error("❌ Erreur setup stock:", err);
      return ctx.reply(`❌ Erreur : ${err.message}`);
    }
  });

  telegram.action("menu:bump", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();

    const status = bumpReminderActive ? "✅ activés" : "⏸️ en pause";

    return ctx.editMessageText(
      `🔔 Rappels bump Disboard\n\nStatut actuel : ${status}\n\nLe bot ne bump pas à ta place : il te rappelle juste de faire /bump manuellement, ce qui est beaucoup plus safe.\n\nAprès chaque bump, clique sur ✅ Bump fait pour programmer le prochain rappel dans 2h.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("▶️ Activer rappels", "bump:start")],
        [Markup.button.callback("✅ Bump fait", "bump:done")],
        [Markup.button.callback("⏰ Test 10 secondes", "bump:test")],
        [Markup.button.callback("⏸️ Pause rappels", "bump:pause")],
        [Markup.button.callback("⬅️ Menu", "bump:menu")],
      ])
    );
  });

  telegram.action("bump:start", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    scheduleBumpReminder(ctx.chat.id, BUMP_DELAY_MS);
    await ctx.answerCbQuery("Rappels activés");
    return ctx.reply("✅ Rappels bump activés.\n\nJe te préviens dans 2h. Après chaque bump, clique sur ✅ Bump fait.");
  });

  telegram.action("bump:done", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    scheduleBumpReminder(ctx.chat.id, BUMP_DELAY_MS);
    await ctx.answerCbQuery("Prochain rappel dans 2h");
    return ctx.reply("✅ Bump noté.\n\nJe te rappelle dans 2h pour le prochain /bump.");
  });

  telegram.action("bump:snooze", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    scheduleBumpReminder(ctx.chat.id, 15 * 60 * 1000);
    await ctx.answerCbQuery("Rappel dans 15 min");
    return ctx.reply("⏰ Ok, je te rappelle dans 15 minutes.");
  });

  telegram.action("bump:test", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    scheduleBumpReminder(ctx.chat.id, 10 * 1000);
    await ctx.answerCbQuery("Test lancé");
    return ctx.reply("🧪 Test lancé : je t’envoie un rappel dans 10 secondes.");
  });

  telegram.action("bump:pause", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    bumpReminderActive = false;
    clearBumpReminder();
    await ctx.answerCbQuery("Rappels en pause");
    return ctx.reply("⏸️ Rappels bump mis en pause.");
  });

  telegram.action("bump:menu", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    return ctx.editMessageText(`⚡ ${SHOP_NAME} TURBO MANAGER\n\nQue veux-tu faire ?`, mainMenu());
  });



  telegram.action("menu:pubmanager", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();

    return ctx.editMessageText(
      `📣 PUB MANAGER NEXO MARKET\n\nChoisis le serveur où tu veux poster.\n\nCooldown par défaut : 2h\n\n🍣 Ze Sushi Pub — pub rapides — ${remainingCooldownText("sushi")}\n📢 Drop Ta Pub — pub rapide — ${remainingCooldownText("drop")}\n\nLe bouton ouvre directement le bon salon Discord. Tu copies le message, tu colles, puis tu cliques ✅ Pub postée.`,
      pubMenuKeyboard()
    );
  });

  telegram.action(/^pubserver:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    const item = PUB_SERVERS[key];
    if (!item) return ctx.answerCbQuery("Serveur inconnu");

    await ctx.answerCbQuery();

    return ctx.editMessageText(
      `📣 ${item.label}\n\nStatut cooldown : ${remainingCooldownText(key)}\nCooldown réglé : 2h\n\nMessage affiché dessous. Pour copier propre : clique 📋 Message seul à copier, reste appuyé sur le message Telegram, puis Copier.\n\nEnsuite :\n1. Clique 📋 Message seul à copier\n2. Copie le message Telegram\n3. Clique 📲 Ouvrir le salon Discord\n4. Colle + envoie\n5. Reviens ici et clique ✅ Pub postée`,
      pubServerKeyboard(key)
    );
  });

  telegram.action(/^pubdone:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    const item = PUB_SERVERS[key];
    if (!item) return ctx.answerCbQuery("Serveur inconnu");

    pubCooldowns[key] = Date.now();
    vData.counters.pubsPosted += 1; saveVData();
    await schedulePubReminder(ctx, key);

    await ctx.answerCbQuery("Cooldown lancé");
    return ctx.reply(
      `✅ Pub notée pour ${item.label}\n\nJe te rappelle dans 2h pour ce serveur.`,
      Markup.inlineKeyboard([
        [Markup.button.url("📲 Ouvrir le salon Discord", pubLink(key))],
        [Markup.button.callback("📣 Retour pubs", "menu:pubmanager")],
      ])
    );
  });

  telegram.action(/^pubremind:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    const item = PUB_SERVERS[key];
    if (!item) return ctx.answerCbQuery("Serveur inconnu");

    await schedulePubReminder(ctx, key);
    await ctx.answerCbQuery("Rappel programmé");
    return ctx.reply(`⏰ Ok, je te rappelle dans 2h pour ${item.label}.`);
  });

  telegram.action(/^pubcopy:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    const key = ctx.match[1];
    const item = PUB_SERVERS[key];
    if (!item) return ctx.answerCbQuery("Serveur inconnu");

    await ctx.answerCbQuery("Message envoyé");
    await ctx.reply(PUB_MESSAGE, {
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [{ text: "📲 Ouvrir le salon Discord", url: pubLink(key) }],
          [{ text: "✅ Pub postée", callback_data: `pubdone:${key}` }],
          [{ text: "⬅️ Retour pubs", callback_data: "menu:pubmanager" }],
        ],
      },
    });
  });

  telegram.action("pub:copy", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery("Message envoyé");
    return ctx.reply(PUB_MESSAGE, { disable_web_page_preview: true });
  });

  telegram.action("pubmanager:main", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    return ctx.editMessageText(`⚡ ${SHOP_NAME} TURBO MANAGER\n\nQue veux-tu faire ?`, mainMenu());
  });


  telegram.action("menu:stats", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    const guild = await refreshGuild();
    return ctx.editMessageText(`📊 STATS ${SHOP_NAME}\n\n${vStatsText(guild)}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Menu", "bump:menu")]]));
  });

  telegram.action("menu:security", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    return ctx.editMessageText(`🚨 SÉCURITÉ\n\nÉtat : ${vData.locked ? "🔒 LOCK" : "🔓 OUVERT"}\n\nLock = bloque l’écriture dans les salons discussion principaux.`, Markup.inlineKeyboard([
      [Markup.button.callback("🔒 Lock serveur", "security:lock")],
      [Markup.button.callback("🔓 Unlock serveur", "security:unlock")],
      [Markup.button.callback("⬅️ Menu", "bump:menu")],
    ]));
  });

  telegram.action("security:lock", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery("Lock...");
    try { await lockServer(); return ctx.reply("🔒 Serveur lock : discussion/questions/partenariats bloqués."); }
    catch (err) { return ctx.reply(`❌ Erreur lock : ${err.message}`); }
  });

  telegram.action("security:unlock", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery("Unlock...");
    try { await unlockServer(); return ctx.reply("🔓 Serveur unlock : les membres peuvent réécrire."); }
    catch (err) { return ctx.reply(`❌ Erreur unlock : ${err.message}`); }
  });

  telegram.action("menu:tickets", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    const open = Object.values(vData.tickets).filter(t => t.status !== "fermé");
    const lines = open.slice(-12).map(t => `#${t.channelName} — ${t.status} — ${t.username || t.userId}`);
    return ctx.editMessageText(`🎟️ TICKETS\n\nOuverts : ${open.length}\n\n${lines.join("\n") || "Aucun ticket suivi."}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Menu", "bump:menu")]]));
  });

  telegram.action("menu:clients", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    await ctx.answerCbQuery();
    const lines = Object.values(vData.clients).slice(-12).map(c => `👤 ${c.username} — commandes:${c.orders} — livrées:${c.delivered}`);
    return ctx.editMessageText(`👤 CLIENTS\n\n${lines.join("\n") || "Aucun client suivi."}`, Markup.inlineKeyboard([[Markup.button.callback("⬅️ Menu", "bump:menu")]]));
  });

  telegram.action("menu:price", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    pending.set(ctx.from.id, { type: "price" });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      "💸 Envoie le prix au format :\n\nclé prix\n\nExemples :\ntech16 29,99€\nsncf 24,99€\nkfc selon stock\n\nClés : tech16, sncf, carrefourProvider, carrefourOrders, kfc, pokemon, ia"
    );
  });

  telegram.action("menu:promo", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    pending.set(ctx.from.id, { type: "promo" });
    await ctx.answerCbQuery();
    return ctx.editMessageText("🔥 Envoie la promo au format :\n\nTitre | Message");
  });

  telegram.action("menu:announce", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Non autorisé");
    pending.set(ctx.from.id, { type: "announce" });
    await ctx.answerCbQuery();
    return ctx.editMessageText("📢 Envoie l’annonce au format :\n\nTitre | Message");
  });

  telegram.on("text", async (ctx) => {
    if (!isAdmin(ctx)) {
      return ctx.reply(`Ton ID Telegram est : ${ctx.from.id}\nMets ce nombre dans TELEGRAM_ADMIN_ID puis relance.`);
    }

    const state = pending.get(ctx.from.id);
    if (!state) return ctx.reply("Utilise /start pour ouvrir le menu.");

    const text = ctx.message.text.trim();

    if (state.type === "price") {
      const [key, ...priceParts] = text.split(" ");
      const price = priceParts.join(" ").trim();
      if (!stockState[key] || !price) return ctx.reply("Format invalide. Exemple :\ntech16 29,99€");

      try {
        stockState[key].price = price;
        await updateOneStockCard(key);
        await updatePricePanel();
        pending.delete(ctx.from.id);
        return ctx.reply(`✅ Prix mis à jour : ${stockState[key].label} → ${price}`);
      } catch (err) {
        console.error("❌ Erreur prix:", err);
        return ctx.reply(`❌ Erreur : ${err.message}`);
      }
    }

    if (state.type === "promo") {
      const [title, ...parts] = text.split("|");
      const msg = parts.join("|").trim();
      if (!title || !msg) return ctx.reply("Format invalide : Titre | Message");

      try {
        await sendPromo(`🔥 ${title.trim()}`, msg);
        pending.delete(ctx.from.id);
        return ctx.reply("✅ Promo envoyée dans Discord.");
      } catch (err) {
        return ctx.reply(`❌ Erreur : ${err.message}`);
      }
    }

    if (state.type === "announce") {
      const [title, ...parts] = text.split("|");
      const msg = parts.join("|").trim();
      if (!title || !msg) return ctx.reply("Format invalide : Titre | Message");

      try {
        await sendAnnouncement(`📢 ${title.trim()}`, msg);
        pending.delete(ctx.from.id);
        return ctx.reply("✅ Annonce envoyée dans Discord.");
      } catch (err) {
        return ctx.reply(`❌ Erreur : ${err.message}`);
      }
    }
  });

  telegram.catch((err) => console.error("❌ Erreur Telegram:", err));

  telegram.launch()
    .then(() => console.log("✅ Telegram TURBO connecté."))
    .catch((err) => console.error("❌ Telegram ne démarre pas:", err));
}

async function createTicket(interaction, type) {
  const guild = interaction.guild;
  await guild.roles.fetch();
  await guild.channels.fetch();

  const staff = guild.roles.cache.find((r) => r.name === STAFF_ROLE_NAME);
  const member = guild.roles.cache.find((r) => r.name === MEMBER_ROLE_NAME);

  if (member && !interaction.member.roles.cache.has(member.id)) {
    return interaction.reply({ content: "Tu dois d’abord valider le règlement et la vérification.", ephemeral: true });
  }

  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.topic && c.topic.includes(`owner:${interaction.user.id}`));
  if (existing) return interaction.reply({ content: `Tu as déjà un ticket ouvert : ${existing}`, ephemeral: true });

  const cat = guild.channels.cache.find((c) => c.name === "🎫・TICKETS OUVERTS" && c.type === ChannelType.GuildCategory);
  const username = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "client";

  const channel = await guild.channels.create({
    name: `ticket-${type}-${username}`,
    type: ChannelType.GuildText,
    parent: cat ? cat.id : null,
    topic: `owner:${interaction.user.id};type:${type}`,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AttachFiles] },
      ...(staff ? [{ id: staff.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.ManageMessages] }] : []),
    ],
  });

  vData.counters.ticketsOpened += 1;
  vData.tickets[channel.id] = { userId: interaction.user.id, username: interaction.user.username, channelName: channel.name, status: "ouvert", type, createdAt: Date.now() };
  ensureClient(interaction.user.id, interaction.user.username);
  saveVData();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("nexo_order_form").setLabel("📝 Remplir demande").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("nexo_payment").setLabel("💳 Infos paiement").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("nexo_close").setLabel("🔒 Fermer").setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `${interaction.user} ${staff ? `<@&${staff.id}>` : ""}`,
    embeds: [E(`🎟️ Ticket ${type}`, "Le staff confirmera disponibilité, prix exact et conditions avant paiement.")],
    components: [row, orderStatusRow()],
  });

  return interaction.reply({ content: `Ticket créé : ${channel}`, ephemeral: true });
}

discord.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === "nexo_verify") {
        const code = Math.floor(1000 + Math.random() * 9000).toString();
        const modal = new ModalBuilder().setCustomId(`nexo_captcha:${code}`).setTitle("Vérification");
        const input = new TextInputBuilder().setCustomId("code").setLabel(`Recopie ce code : ${code}`).setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "nexo_ticket_order") return createTicket(interaction, "commande");
      if (interaction.customId === "nexo_ticket_question") return createTicket(interaction, "question");
      if (interaction.customId === "nexo_ticket_problem") return createTicket(interaction, "litige");


      if (interaction.customId === "nexo_order_form") {
        const modal = new ModalBuilder().setCustomId("nexo_order_submit").setTitle("Demande de commande");
        modal.addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("offer").setLabel("Offre souhaitée").setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("qty").setLabel("Quantité / détails").setStyle(TextInputStyle.Short).setRequired(true)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("budget").setLabel("Budget / prix vu").setStyle(TextInputStyle.Short).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("pay").setLabel("Moyen de paiement").setStyle(TextInputStyle.Short).setRequired(false)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("comment").setLabel("Commentaire").setStyle(TextInputStyle.Paragraph).setRequired(false))
        );
        return interaction.showModal(modal);
      }

      if (interaction.customId === "order_validated") return setTicketStatus(interaction, "validée");
      if (interaction.customId === "order_paid") return setTicketStatus(interaction, "payée");
      if (interaction.customId === "order_progress") return setTicketStatus(interaction, "en cours");
      if (interaction.customId === "order_delivered") return setTicketStatus(interaction, "livrée");
      if (interaction.customId === "order_problem") return setTicketStatus(interaction, "problème");

      if (interaction.customId === "nexo_payment") {
        return interaction.reply({ ephemeral: true, embeds: [E("💳 Infos paiement", `Paiement uniquement après validation du staff.\n\nPayPal : ${PAYPAL_LINK}`)] });
      }

      if (interaction.customId === "nexo_close") {
        if (vData.tickets[interaction.channel.id]) { vData.tickets[interaction.channel.id].status = "fermé"; vData.counters.ticketsClosed += 1; saveVData(); }
        const messages = await interaction.channel.messages.fetch({ limit: 100 });
        const transcript = messages.reverse().map((m) => `[${m.createdAt.toISOString()}] ${m.author.tag}: ${m.content || "[embed/fichier/bouton]"}`).join("\n");
        const file = new AttachmentBuilder(Buffer.from(transcript, "utf-8"), { name: `transcript-${interaction.channel.name}.txt` });
        await interaction.reply({ content: "Ticket fermé dans 5 secondes. Transcript :", files: [file] });
        setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("nexo_captcha:")) {
        const expected = interaction.customId.split(":")[1];
        const got = interaction.fields.getTextInputValue("code").trim();
        if (got !== expected) return interaction.reply({ content: "Code incorrect.", ephemeral: true });

        const role = interaction.guild.roles.cache.find((r) => r.name === MEMBER_ROLE_NAME);
        if (role) await interaction.member.roles.add(role);
        return interaction.reply({ content: "Vérification réussie ✅", ephemeral: true });
      }

      if (interaction.customId === "nexo_order_submit") {
        const offer = interaction.fields.getTextInputValue("offer");
        const qty = interaction.fields.getTextInputValue("qty");
        const budget = interaction.fields.getTextInputValue("budget") || "Non précisé";
        const pay = interaction.fields.getTextInputValue("pay") || "Non précisé";
        const comment = interaction.fields.getTextInputValue("comment") || "Aucun";
        if (vData.tickets[interaction.channel.id]) { vData.tickets[interaction.channel.id].offer = offer; vData.tickets[interaction.channel.id].status = "demande envoyée"; saveVData(); }
        await interaction.channel.send({
          embeds: [E("📝 Nouvelle demande", [`**Client :** ${interaction.user}`, `**Offre :** ${offer}`, `**Quantité / détails :** ${qty}`, `**Budget / prix vu :** ${budget}`, `**Paiement :** ${pay}`, `**Commentaire :** ${comment}`, "", "Le staff confirme disponibilité, prix final et conditions avant paiement."].join("\n"), 0x5865f2)],
          components: [orderStatusRow()],
        });
        return interaction.reply({ content: "Demande envoyée dans le ticket.", ephemeral: true });
      }
    }
  } catch (err) {
    console.error("❌ Erreur Discord:", err);
    if (!interaction.replied) return interaction.reply({ content: "Erreur bot.", ephemeral: true }).catch(() => {});
  }
});

discord.once("clientReady", async () => {
  console.log(`✅ Discord connecté en tant que ${discord.user.tag}`);
  startTelegram();
  console.log("⚡ Bot TURBO lancé.");

  try {
    await ensureStockDashboard();
    console.log("✅ Dashboard stock turbo prêt.");
  } catch (err) {
    console.log(`⚠️ Dashboard stock non créé automatiquement : ${err.message}`);
  }
});

process.once("SIGINT", () => {
  if (telegram) telegram.stop("SIGINT");
  discord.destroy();
});

process.once("SIGTERM", () => {
  if (telegram) telegram.stop("SIGTERM");
  discord.destroy();
});

discord.login(TOKEN);
