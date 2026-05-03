const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, Events } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const config = require('./config.json');
const express = require('express');

// 🌐 سيرفر ويب لضمان بقاء الخدمة متصلة على Render
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Valorant Bot is Alive!'));
app.listen(port, () => console.log(`🌐 Web server is running on port ${port}`));

puppeteer.use(StealthPlugin());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.MessageContent
    ],
    rest: { timeout: 90000 } // زيادة وقت انتظار ديسكورد
});

let users = {};
try {
    if (fs.existsSync('./users.json')) {
        users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
    }
} catch (e) {
    console.error("❌ Error loading users.json:", e);
    users = {};
}

async function fetchStatsFromWeb(riotId) {
    const parts = riotId.split('#');
    if (parts.length < 2) return null;
    const url = `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(parts[0].trim())}%23${parts[1].trim()}/overview`;
    
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process'
            ] 
        });
        
        const page = await browser.newPage();

        // 🚀 تسريع السحب: منع تحميل العناصر الثقيلة
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // الانتظار حتى تحميل الهيكل الأساسي (وقت صبّر 90 ثانية)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        
        // 🎯 الانتظار حتى ظهور الأرقام الفعلية
        await page.waitForSelector('.numbers', { timeout: 40000 }).catch(() => null);

        const stats = await page.evaluate(() => {
            const getVal = (label) => {
                const el = Array.from(document.querySelectorAll('.stat')).find(e => e.innerText.includes(label));
                if (!el) return "0";
                const valEl = el.querySelector('.value');
                return valEl ? valEl.innerText.trim() : "0";
            };
            
            const matchRows = Array.from(document.querySelectorAll('.match-row')).slice(0, 3);
            const recent = matchRows.map(row => ({
                win: row.classList.contains('is-win'),
                kills: row.querySelector('.stats .value')?.innerText.trim() || "0"
            }));

            return {
                kd: parseFloat(getVal('K/D Ratio')) || 0,
                wr: getVal('Win %') || "0%",
                hs: getVal('Headshot %') || "0%",
                kills: getVal('Kills') || "0",
                deaths: getVal('Deaths') || "0",
                matches: getVal('Matches') || "0",
                recent: recent
            };
        });
        
        await browser.close();
        return stats;
    } catch (e) {
        console.error(`❌ Puppeteer Error for ${riotId}:`, e.message);
        if (browser) await browser.close().catch(() => null);
        return null;
    }
}

async function updateLeaderboardChannel() {
    console.log('🔄 Updating Auto-Leaderboard...');
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel) return console.log('❌ Leaderboard channel not found!');

    const userIds = Object.keys(users);
    if (userIds.length === 0) return console.log('⚠️ No users in the list.');

    let leaderboardData = [];
    for (const userId of userIds) {
        const riotId = users[userId].riotId;
        const stats = await fetchStatsFromWeb(riotId);
        if (stats && stats.matches !== "0") {
            leaderboardData.push({ userId, riotId, kd: stats.kd, wr: stats.wr });
        }
    }

    if (leaderboardData.length === 0) return console.log('❌ Failed to fetch any real stats.');

    leaderboardData.sort((a, b) => b.kd - a.kd);

    const embed = new EmbedBuilder()
        .setTitle('🏆 Valorant Server Leaderboard')
        .setColor('#291655')
        .setDescription('ترتيب اللاعبين حسب الأداء (K/D Ratio)\n⏳ **يتحدث تلقائياً كل 30 دقيقة**')
        .setImage('https://i.postimg.cc/KRFjHxXP/image.png')
        .setFooter({ text: 'Last Updated' })
        .setTimestamp();

    let rank = 1;
    for (const player of leaderboardData) {
        let rankEmoji = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅';
        embed.addFields({
            name: `${rankEmoji} Rank #${rank} - ${player.riotId}`,
            value: `<@${player.userId}>\n**K/D:** \`${player.kd}\` | **Win Rate:** \`${player.wr}\``,
            inline: false
        });
        rank++;
    }

    try {
        const messages = await channel.messages.fetch({ limit: 10 });
        const oldMessage = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === '🏆 Valorant Server Leaderboard');

        if (oldMessage) {
            await oldMessage.edit({ embeds: [embed] });
            console.log('✅ Auto-Leaderboard updated.');
        } else {
            await channel.send({ embeds: [embed] });
            console.log('✅ Auto-Leaderboard created.');
        }
    } catch (err) {
        console.error('❌ Error updating leaderboard message:', err.message);
    }
}

const commands = [
    new SlashCommandBuilder()
        .setName('link')
        .setDescription('ربط حسابك في فالورانت بالليدربورد')
        .addStringOption(opt => opt.setName('riotid').setDescription('Name#TAG').setRequired(true)),
    new SlashCommandBuilder()
        .setName('profile')
        .setDescription('عرض ملفك الشخصي المفصل لإحصائيات فالورانت')
];

client.once(Events.ClientReady, async () => {
    console.log(`✅ ${client.user.tag} Is Online!`);
    
    const rest = new REST({ version: '10' }).setToken(config.token);
    try {
        await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
        await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
        console.log('✨ Slash Commands Registered Successfully!');
    } catch (error) {
        console.error('❌ Command Registry Error:', error);
    }

    // الانتظار قليلاً لضمان استقرار السيرفر قبل أول تحديث
    setTimeout(updateLeaderboardChannel, 20000);
    setInterval(updateLeaderboardChannel, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'link') {
        try {
            await interaction.deferReply({ ephemeral: true });
            const riotId = interaction.options.getString('riotid');

            if (!riotId.includes('#')) {
                return interaction.editReply('❌ الصيغة خاطئة! مثال: `Name#TAG`');
            }

            users[interaction.user.id] = { riotId };
            fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
            await interaction.editReply(`✅ تم ربط حسابك (**${riotId}**) بنجاح! سيتم تحديث الترتيب قريباً.`);
            updateLeaderboardChannel(); 
        } catch (err) {
            console.error(err);
            if (interaction.deferred) await interaction.editReply('❌ حدث خطأ أثناء الحفظ. جرب مرة أخرى.').catch(() => null);
        }
    }

    if (interaction.commandName === 'profile') {
        if (!users[interaction.user.id]) {
            return interaction.reply({ content: '❌ يجب عليك ربط حسابك أولاً باستخدام `/link`.', ephemeral: true });
        }

        try {
            await interaction.deferReply(); 
            const stats = await fetchStatsFromWeb(users[interaction.user.id].riotId);
            
            if (!stats) return interaction.editReply('❌ فشل جلب البيانات. تأكد أن حسابك Public في Tracker.gg.');

            const profileEmbed = new EmbedBuilder()
                .setTitle(`👤 Combatant: ${interaction.user.username}`)
                .setDescription(`Riot ID: \`${users[interaction.user.id].riotId}\``)
                .setThumbnail(interaction.user.displayAvatarURL())
                .setColor('#291655')
                .addFields(
                    { name: '🎯 K/D Ratio', value: `\`${stats.kd}\``, inline: true },
                    { name: '📈 Win Rate', value: `\`${stats.wr}\``, inline: true },
                    { name: '🎯 Headshot %', value: `\`${stats.hs}\``, inline: true },
                    { name: '💀 Kills', value: `\`${stats.kills}\``, inline: true },
                    { name: '🎮 Matches', value: `\`${stats.matches}\``, inline: true },
                    { name: '🕒 Recent Form', value: stats.recent.map(m => `\`${m.win ? 'W' : 'L'} (${m.kills}K)\``).join(' → ') || 'N/A' }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [profileEmbed] });
        } catch (err) {
            console.error(err);
            if (interaction.deferred) await interaction.editReply('❌ حدث خطأ تقني. السيرفر بطيء حالياً، جرب لاحقاً.').catch(() => null);
        }
    }
});

client.login(config.token);
