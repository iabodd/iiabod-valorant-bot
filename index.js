const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, Events } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const config = require('./config.json');
const express = require('express');

// 🌐 سيرفر ويب متوافق مع Render
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Valorant Bot is Alive and Running!'));
app.listen(port, () => console.log(`🌐 Web server is running on port ${port}`));

puppeteer.use(StealthPlugin());

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.MessageContent
    ],
    rest: { timeout: 60000 } 
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
        // 🛡️ [تعديل] حماية المتصفح عشان ما يطفي البوت إذا فشل الإقلاع
        browser = await puppeteer.launch({ 
            headless: "new", 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-zygote',
                '--single-process' // يخفف استهلاك الرام لأقصى حد
            ] 
        });
        
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.waitForSelector('.main', { timeout: 15000 }).catch(() => null);

        const stats = await page.evaluate(() => {
            const getVal = (label) => {
                const el = Array.from(document.querySelectorAll('.stat')).find(e => e.innerText.includes(label));
                return el ? el.querySelector('.value').innerText : "0";
            };
            const matchRows = Array.from(document.querySelectorAll('.match-row')).slice(0, 3);
            const recent = matchRows.map(row => ({
                win: row.classList.contains('is-win'),
                kills: row.querySelector('.stats .value')?.innerText || "0"
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
    const userIds = Object.keys(users);
    if (userIds.length === 0) return console.log('⚠️ No users to update.');

    let leaderboardData = [];
    for (const userId of userIds) {
        const riotId = users[userId].riotId;
        const stats = await fetchStatsFromWeb(riotId);
        if (stats) {
            leaderboardData.push({ userId, riotId, kd: stats.kd, wr: stats.wr });
        }
    }

    if (leaderboardData.length === 0) return console.log('❌ Failed to fetch stats for auto-update.');

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
        let rankEmoji = '🏅';
        if (rank === 1) rankEmoji = '🥇';
        if (rank === 2) rankEmoji = '🥈';
        if (rank === 3) rankEmoji = '🥉';

        embed.addFields({
            name: `${rankEmoji} Rank #${rank} - ${player.riotId}`,
            value: `<@${player.userId}>\n**K/D:** \`${player.kd}\` | **Win Rate:** \`${player.wr}\``,
            inline: false
        });
        rank++;
    }

    try {
        const channel = await client.channels.fetch(config.channelId).catch(() => null);
        if (!channel) return console.log('❌ Leaderboard channel not found!');

        const messages = await channel.messages.fetch({ limit: 10 });
        const oldMessage = messages.find(m => m.author.id === client.user.id && m.embeds.length > 0 && m.embeds[0].title === '🏆 Valorant Server Leaderboard');

        if (oldMessage) {
            await oldMessage.edit({ embeds: [embed] });
            console.log('✅ Auto-Leaderboard edited successfully.');
        } else {
            await channel.send({ embeds: [embed] });
            console.log('✅ Auto-Leaderboard sent successfully.');
        }
    } catch (err) {
        console.error('❌ Error in auto-updating channel:', err);
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
        console.log('🧹 Cleaning old commands and registering new ones...');
        await rest.put(Routes.applicationCommands(config.clientId), { body: [] });
        await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
        console.log('✨ Slash Commands Registered Successfully!');
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }

    setTimeout(updateLeaderboardChannel, 10000);
    setInterval(updateLeaderboardChannel, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'link') {
        await interaction.deferReply({ ephemeral: true });
        const riotId = interaction.options.getString('riotid');

        if (!riotId.includes('#')) {
            return interaction.editReply('❌ الصيغة خاطئة! مثال: `Name#TAG`');
        }

        try {
            users[interaction.user.id] = { riotId };
            fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
            await interaction.editReply(`✅ تم ربط حسابك (**${riotId}**) بنجاح! إحصائياتك رح تظهر مع التحديث القادم لليدربورد.`);
            updateLeaderboardChannel(); 
        } catch (err) {
            console.error(err);
            await interaction.editReply('❌ حدث خطأ أثناء حفظ البيانات.');
        }
    }

    if (interaction.commandName === 'profile') {
        if (!users[interaction.user.id]) {
            return interaction.reply({ content: '❌ يجب عليك ربط حسابك أولاً باستخدام `/link`.', ephemeral: true });
        }

        await interaction.deferReply(); 
        
        try {
            const stats = await fetchStatsFromWeb(users[interaction.user.id].riotId);
            if (!stats) return interaction.editReply('❌ فشل جلب البيانات. تأكد أن حسابك العام (Public).');

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
            await interaction.editReply('❌ حدث خطأ تقني أثناء جلب الملف الشخصي.');
        }
    }
});

client.login(config.token);