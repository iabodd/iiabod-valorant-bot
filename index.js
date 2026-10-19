const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, Events } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const fs = require('fs');
const config = require('./config.json');

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`[Server] Listening on port ${PORT}`));

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
    rest: { timeout: 60000 }
});

const DB_PATH = './users.json';
let users = fs.existsSync(DB_PATH) ? JSON.parse(fs.readFileSync(DB_PATH, 'utf8')) : {};
let isUpdating = false;

function saveUsers() {
    fs.writeFileSync(DB_PATH, JSON.stringify(users, null, 2));
}

async function getValorantStats(riotId, sharedBrowser = null) {
    if (!riotId || !riotId.includes('#')) return null;

    const [name, tag] = riotId.split('#').map(s => s.trim());
    if (!name || !tag) return null;

    const targetUrl = `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(name)}\%23${encodeURIComponent(tag)}/overview`;
    
    let browser = sharedBrowser;
    let page = null;

    try {
        if (!browser) {
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
            });
        }

        page = await browser.newPage();
        await page.setRequestInterception(true);
        
        page.on('request', req => {
            const type = req.resourceType();
            if (type === 'image' || type === 'font' || type === 'media' || type === 'stylesheet') {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.stat .value', { timeout: 30000 }).catch(() => null);

        const data = await page.evaluate(() => {
            const statsList = Array.from(document.querySelectorAll('.stat'));
            const extract = (key) => {
                const el = statsList.find(item => item.innerText.toLowerCase().includes(key.toLowerCase()));
                return el?.querySelector('.value')?.innerText?.trim() || '0';
            };

            return {
                kd: parseFloat(extract('K/D Ratio')) || 0,
                wr: extract('Win %'),
                hs: extract('Headshot %'),
                kills: extract('Kills'),
                matches: extract('Matches')
            };
        });

        await page.close();
        if (!sharedBrowser) await browser.close();

        return data.matches !== '0' ? data : null;
    } catch (err) {
        console.error(`[Scraper] Failed for ${riotId}:${err.message}`);
        if (page) await page.close().catch(() => {});
        if (browser && !sharedBrowser) await browser.close().catch(() => {});
        return null;
    }
}

async function refreshLeaderboard() {
    if (isUpdating) return;
    isUpdating = true;

    console.log('[Leaderboard] Starting update cycle...');
    let browser = null;

    try {
        const channel = await client.channels.fetch(config.channelId).catch(() => null);
        if (!channel) {
            isUpdating = false;
            return;
        }

        const userIds = Object.keys(users);
        if (userIds.length === 0) {
            isUpdating = false;
            return;
        }

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const standings = [];

        for (const uid of userIds) {
            const riotId = users[uid]?.riotId;
            if (!riotId) continue;

            const stats = await getValorantStats(riotId, browser);
            if (stats) {
                standings.push({
                    userId: uid,
                    riotId,
                    kd: stats.kd,
                    wr: stats.wr
                });
            }
        }

        await browser.close();
        browser = null;

        if (standings.length === 0) {
            console.log('[Leaderboard] No valid stats fetched, skipping edit.');
            isUpdating = false;
            return;
        }

        standings.sort((a, b) => b.kd - a.kd);
        const topPlayers = standings.slice(0, 25); // Discord embed field limit

        const embed = new EmbedBuilder()
            .setTitle('🏆 Valorant Server Leaderboard')
            .setColor('#291655')
            .setDescription('الترتيب المحدث بناءً على K/D Ratio')
            .setImage('https://i.postimg.cc/KRFjHxXP/image.png')
            .setTimestamp();

        const medals = ['🥇', '🥈', '🥉'];
        topPlayers.forEach((player, idx) => {
            const badge = medals[idx] || '🏅';
            embed.addFields({
                name: `${badge} Rank #${idx + 1} -${player.riotId}`,
                value: `<@${player.userId}>\n**K/D:** \`${player.kd}\` | **Win Rate:** \`${player.wr}\``
            });
        });

        const recentMsgs = await channel.messages.fetch({ limit: 15 });
        const boardMsg = recentMsgs.find(m => m.author.id === client.user.id && m.embeds[0]?.title === '🏆 Valorant Server Leaderboard');

        if (boardMsg) {
            await boardMsg.edit({ embeds: [embed] });
        } else {
            await channel.send({ embeds: [embed] });
        }

        console.log('[Leaderboard] Updated successfully.');
    } catch (err) {
        console.error('[Leaderboard] Update error:', err.message);
        if (browser) await browser.close().catch(() => {});
    } finally {
        isUpdating = false;
    }
}

client.once(Events.ClientReady, async (c) => {
    console.log(`[Bot] Logged in as ${c.user.tag}`);

    const commands = [
        new SlashCommandBuilder()
            .setName('link')
            .setDescription('ربط حسابك بالبوت')
            .addStringOption(opt => opt.setName('riotid').setDescription('Name#TAG').setRequired(true)),
        new SlashCommandBuilder()
            .setName('profile')
            .setDescription('عرض إحصائيات ملفك الشخصي')
    ].map(cmd => cmd.toJSON());

    try {
        const rest = new REST({ version: '10' }).setToken(config.token);
        await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    } catch (err) {
        console.error('[Slash] Command registration failed:', err.message);
    }

    setTimeout(refreshLeaderboard, 10000);
    setInterval(refreshLeaderboard, 30 * 60 * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, user } = interaction;

    if (commandName === 'link') {
        const riotId = interaction.options.getString('riotid').trim();
        if (!riotId.includes('#')) {
            return interaction.reply({ content: 'صيغة الحساب غير صحيحة، لازم تكون بهذا الشكل: `Name#TAG`', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        users[user.id] = { riotId };
        saveUsers();

        await interaction.editReply(`تم ربط حسابك **${riotId}** بنجاح، جاري تحديث الترتيب...`);
        refreshLeaderboard();
    }

    if (commandName === 'profile') {
        const userData = users[user.id];
        if (!userData) {
            return interaction.reply({ content: 'حسابك غير مربوط، استخدم أمر `/link` أولاً.', ephemeral: true });
        }

        await interaction.deferReply();
        const stats = await getValorantStats(userData.riotId);

        if (!stats) {
            return interaction.editReply('ما قدرت أجيب البيانات، تأكد أن اسم الحساب صحيح وأنه عام (Public) في موقع Tracker.');
        }

        const profileEmbed = new EmbedBuilder()
            .setTitle(`👤 ${user.username} (${userData.riotId})`)
            .addFields(
                { name: '🎯 K/D', value: `\`${stats.kd}\``, inline: true },
                { name: '📈 Win Rate', value: `\`${stats.wr}\``, inline: true },
                { name: '🔥 Headshot %', value: `\`${stats.hs}\``, inline: true }
            )
            .setColor('#291655');

        await interaction.editReply({ embeds: [profileEmbed] });
    }
});

client.login(config.token);
