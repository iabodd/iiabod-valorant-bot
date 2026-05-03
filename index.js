const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, Events } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const config = require('./config.json');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Valorant Bot is Alive!'));
app.listen(port, () => console.log(`🌐 Web server on port ${port}`));

puppeteer.use(StealthPlugin());

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent],
    rest: { timeout: 90000 }
});

let users = {};
if (fs.existsSync('./users.json')) {
    users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
}

async function fetchStatsFromWeb(riotId) {
    const parts = riotId.split('#');
    if (parts.length < 2) return null;
    const url = `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(parts[0].trim())}%23${parts[1].trim()}/overview`;
    
    let browser;
    try {
        browser = await puppeteer.launch({ 
            headless: "new", 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--single-process'] 
        });
        
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // 🛠️ زيادة وقت الانتظار لضمان تحميل الموقع بالكامل في Render
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
        
        // ننتظر ظهور الأرقام الفعلية لمدة كافية
        await page.waitForSelector('.stat .value', { timeout: 45000 }).catch(() => null);

        const stats = await page.evaluate(() => {
            const getVal = (label) => {
                const allStats = Array.from(document.querySelectorAll('.stat'));
                const target = allStats.find(s => s.innerText.toLowerCase().includes(label.toLowerCase()));
                if (!target) return "0";
                const val = target.querySelector('.value');
                return val ? val.innerText.trim() : "0";
            };
            
            return {
                kd: parseFloat(getVal('K/D Ratio')) || 0,
                wr: getVal('Win %') || "0%",
                hs: getVal('Headshot %') || "0%",
                kills: getVal('Kills') || "0",
                matches: getVal('Matches') || "0"
            };
        });
        
        await browser.close();
        // إذا رجعت النتائج أصفار، نعتبرها فشل لعدم تحديث الليدربورد ببيانات خاطئة
        return stats.matches !== "0" ? stats : null;
    } catch (e) {
        console.error(`❌ Error fetching ${riotId}:`, e.message);
        if (browser) await browser.close().catch(() => null);
        return null;
    }
}

async function updateLeaderboardChannel() {
    console.log('🔄 Updating Auto-Leaderboard...');
    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel) return;

    const userIds = Object.keys(users);
    let leaderboardData = [];

    for (const userId of userIds) {
        const stats = await fetchStatsFromWeb(users[userId].riotId);
        if (stats) {
            leaderboardData.push({ userId, riotId: users[userId].riotId, kd: stats.kd, wr: stats.wr });
        }
    }

    if (leaderboardData.length === 0) {
        console.log('❌ Failed to fetch any real stats. Keeping old data.');
        return;
    }

    leaderboardData.sort((a, b) => b.kd - a.kd);

    const embed = new EmbedBuilder()
        .setTitle('🏆 Valorant Server Leaderboard')
        .setColor('#291655')
        .setDescription('الترتيب المحدث بناءً على K/D Ratio')
        .setImage('https://i.postimg.cc/KRFjHxXP/image.png')
        .setTimestamp();

    leaderboardData.forEach((p, i) => {
        const emoji = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '🏅';
        embed.addFields({ name: `${emoji} Rank #${i + 1} - ${p.riotId}`, value: `<@${p.userId}>\n**K/D:** \`${p.kd}\` | **Win Rate:** \`${p.wr}\`` });
    });

    const messages = await channel.messages.fetch({ limit: 10 });
    const oldMsg = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title === '🏆 Valorant Server Leaderboard');

    if (oldMsg) await oldMsg.edit({ embeds: [embed] });
    else await channel.send({ embeds: [embed] });
    console.log('✅ Leaderboard updated successfully!');
}

client.once(Events.ClientReady, async () => {
    console.log(`✅ ${client.user.tag} Online!`);
    const rest = new REST({ version: '10' }).setToken(config.token);
    const commands = [
        new SlashCommandBuilder().setName('link').setDescription('ربط حسابك').addStringOption(o => o.setName('riotid').setDescription('Name#TAG').setRequired(true)),
        new SlashCommandBuilder().setName('profile').setDescription('عرض ملفك الشخصي')
    ];
    await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
    
    setTimeout(updateLeaderboardChannel, 15000);
    setInterval(updateLeaderboardChannel, 30 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'link') {
        await interaction.deferReply({ ephemeral: true });
        const riotId = interaction.options.getString('riotid');
        users[interaction.user.id] = { riotId };
        fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
        await interaction.editReply(`✅ تم ربط **${riotId}**! جاري تحديث البيانات...`);
        updateLeaderboardChannel();
    }
    if (interaction.commandName === 'profile') {
        if (!users[interaction.user.id]) return interaction.reply('❌ اربط حسابك أولاً!');
        await interaction.deferReply();
        const stats = await fetchStatsFromWeb(users[interaction.user.id].riotId);
        if (!stats) return interaction.editReply('❌ فشل جلب البيانات، تأكد أن الحساب Public.');
        const pEmbed = new EmbedBuilder()
            .setTitle(`👤 ${interaction.user.username}`)
            .addFields({ name: '🎯 K/D', value: `\`${stats.kd}\``, inline: true }, { name: '📈 Win Rate', value: `\`${stats.wr}\``, inline: true })
            .setColor('#291655');
        await interaction.editReply({ embeds: [pEmbed] });
    }
});

client.login(config.token);
