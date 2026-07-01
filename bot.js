require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => id.trim()).filter(Boolean);

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in .env file. Get one from @BotFather.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

function isAdmin(ctx) {
  return ADMIN_IDS.includes(String(ctx.from.id));
}

function getOrCreateUser(ctx) {
  const tgId = ctx.from.id;
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
  if (!user) {
    db.prepare('INSERT INTO users (telegram_id, username) VALUES (?, ?)')
      .run(tgId, ctx.from.username || ctx.from.first_name || 'unknown');
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
  }
  return user;
}

const pendingSubmission = new Map();
const pendingTaskCreation = new Map();

bot.start((ctx) => {
  getOrCreateUser(ctx);
  ctx.reply(
    `Welcome ${ctx.from.first_name}! 👋\n\nThis bot lets you earn money completing simple tasks.\n\n` +
    `/tasks - see available tasks\n` +
    `/balance - check your balance\n` +
    `/withdraw - request a payout\n` +
    (isAdmin(ctx) ? `\nAdmin commands:\n/addtask - create a new task\n/pending - review submissions\n/withdrawals - review payout requests` : '')
  );
});

bot.command('tasks', (ctx) => {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE status = 'open' AND slots_filled < slots_total ORDER BY id DESC`).all();
  if (tasks.length === 0) return ctx.reply('No open tasks right now. Check back later!');

  tasks.forEach(task => {
    const slotsLeft = task.slots_total - task.slots_filled;
    ctx.reply(
      `📋 *${task.title}*\n\n${task.description}\n\n💰 Reward: ${task.reward}\n🎟 Slots left: ${slotsLeft}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          Markup.button.callback('✅ Do this task', `dotask_${task.id}`)
        ])
      }
    );
  });
});

bot.action(/dotask_(\d+)/, (ctx) => {
  const taskId = Number(ctx.match[1]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task || task.status !== 'open' || task.slots_filled >= task.slots_total) {
    return ctx.answerCbQuery('This task is no longer available.');
  }
  pendingSubmission.set(ctx.from.id, taskId);
  ctx.answerCbQuery();
  ctx.reply(`Got it. Complete the task, then send me a screenshot as proof (just send the photo here).`);
});

bot.on('photo', async (ctx) => {
  const taskId = pendingSubmission.get(ctx.from.id);
  if (!taskId) return;

  const user = getOrCreateUser(ctx);
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  db.prepare('INSERT INTO submissions (task_id, user_id, photo_file_id) VALUES (?, ?, ?)')
    .run(taskId, user.id, photo.file_id);

  pendingSubmission.delete(ctx.from.id);
  ctx.reply('✅ Proof submitted! You\'ll be notified once it\'s reviewed.');

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  const submissionId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  for (const adminId of ADMIN_IDS) {
    try {
      await ctx.telegram.sendPhoto(adminId, photo.file_id, {
        caption: `New submission #${submissionId}\nTask: ${task.title}\nUser: @${user.username} (id ${user.telegram_id})`,
        ...Markup.inlineKeyboard([
          Markup.button.callback('✅ Approve', `approve_${submissionId}`),
          Markup.button.callback('❌ Reject', `reject_${submissionId}`)
        ])
      });
    } catch (e) {
