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
    `Welcome ${ctx.from.first_name}! 👋\n\nThis bot lets you earn money completing simple tasks.\n\nTap a button below anytime.` +
    (isAdmin(ctx) ? `\n\nAdmin commands:\n/addtask - create a new task\n/pending - review submissions\n/withdrawals - review payout requests` : ''),
    Markup.keyboard([
      ['📋 Tasks', '💰 Balance'],
      ['💸 Withdraw']
    ]).resize()
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
      console.error('Could not notify admin', adminId, e.message);
    }
  }
});

bot.command('balance', (ctx) => {
  const user = getOrCreateUser(ctx);
  ctx.reply(`💰 Your balance: ${user.balance}`);
  });
  bot.command('withdraw', (ctx) => {
  const user = getOrCreateUser(ctx);
  if (user.balance <= 0) return ctx.reply('You have no balance to withdraw.');
  db.prepare('INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)').run(user.id, user.balance);
  ctx.reply(`Withdrawal request for ${user.balance} submitted. You'll be paid once approved.`);

  for (const adminId of ADMIN_IDS) {
    ctx.telegram.sendMessage(adminId, `💸 New withdrawal request from @${user.username}: ${user.balance}\nUse /withdrawals to review.`).catch(() => {});
  }
});

bot.command('addtask', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  pendingTaskCreation.set(ctx.from.id, { step: 'title' });
  ctx.reply('Let\'s create a task. Send the task TITLE:');
});

bot.on('text', (ctx, next) => {
  const state = pendingTaskCreation.get(ctx.from.id);
  if (!state || !isAdmin(ctx)) return next();

  const text = ctx.message.text.trim();

  if (state.step === 'title') {
    state.title = text;
    state.step = 'description';
    return ctx.reply('Send the task DESCRIPTION (instructions for the user):');
  }
  if (state.step === 'description') {
    state.description = text;
    state.step = 'reward';
    return ctx.reply('Send the REWARD amount per completion (number only):');
  }
  if (state.step === 'reward') {
    const reward = parseFloat(text);
    if (isNaN(reward) || reward <= 0) return ctx.reply('Please send a valid positive number for the reward.');
    state.reward = reward;
    state.step = 'slots';
    return ctx.reply('How many SLOTS (max number of people who can complete this)?');
  }
  if (state.step === 'slots') {
    const slots = parseInt(text, 10);
    if (isNaN(slots) || slots <= 0) return ctx.reply('Please send a valid positive whole number for slots.');
    db.prepare('INSERT INTO tasks (title, description, reward, slots_total) VALUES (?, ?, ?, ?)')
      .run(state.title, state.description, state.reward, slots);
    pendingTaskCreation.delete(ctx.from.id);
    return ctx.reply(`✅ Task created: "${state.title}" — reward ${state.reward} x ${slots} slots.`);
  }
});

bot.command('pending', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const subs = db.prepare(`

SELECT submissions.id, tasks.title, users.username, users.telegram_id
    FROM submissions
    JOIN tasks ON submissions.task_id = tasks.id
    JOIN users ON submissions.user_id = users.id
    WHERE submissions.status = 'pending'
    ORDER BY submissions.id ASC
  `).all();

  if (subs.length === 0) return ctx.reply('No pending submissions.');
  subs.forEach(s => {
    ctx.reply(
      `#${s.id} — ${s.title} — @${s.username}`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Approve', `approve_${s.id}`),
        Markup.button.callback('❌ Reject', `reject_${s.id}`)
      ])
    );
  });
});

bot.action(/approve_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  const subId = Number(ctx.match[1]);
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(subId);
  if (!sub || sub.status !== 'pending') return ctx.answerCbQuery('Already handled.');

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sub.task_id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.user_id);

  db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run('approved', subId);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(task.reward, user.id);
  db.prepare('UPDATE tasks SET slots_filled = slots_filled + 1 WHERE id = ?').run(task.id);

  const updatedTask = db.prepare('SELECT * FROM tasks WHERE id = ?').get(task.id);
  if (updatedTask.slots_filled >= updatedTask.slots_total) {
    db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('closed', task.id);
  }

  ctx.answerCbQuery('Approved!');
  ctx.editMessageReplyMarkup();
  ctx.telegram.sendMessage(user.telegram_id, `✅ Your submission for "${task.title}" was approved! +${task.reward} added to your balance.`).catch(() => {});
});

bot.action(/reject_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  const subId = Number(ctx.match[1]);
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(subId);
  if (!sub || sub.status !== 'pending') return ctx.answerCbQuery('Already handled.');

  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(sub.task_id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sub.user_id);

  db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run('rejected', subId);
  ctx.answerCbQuery('Rejected.');
  ctx.editMessageReplyMarkup();
  ctx.telegram.sendMessage(user.telegram_id, `❌ Your submission for "${task.title}" was rejected. Try another task!`).catch(() => {});
});

bot.command('withdrawals', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const reqs = db.prepare(`
    SELECT withdrawals.id, withdrawals.amount, users.username, users.telegram_id
    FROM withdrawals JOIN users ON withdrawals.user_id = users.id
    WHERE withdrawals.status = 'pending'
    ORDER BY withdrawals.id ASC
  `).all();
  if (reqs.length === 0) return ctx.reply('No pending withdrawals.');
  reqs.forEach(r => {
    ctx.reply(
      `#${r.id} — @${r.username} — ${r.amount}`,
      Markup.inlineKeyboard([
        Markup.button.callback('✅ Mark Paid', `paid_${r.id}`),
      ])
    );
  });
});

bot.action(/paid_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  const reqId = Number(ctx.match[1]);
  const req = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(reqId);
  if (!req || req.status !== 'pending') return ctx.answerCbQuery('Already handled.');

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user_id);
  db.prepare('UPDATE withdrawals SET status = ? WHERE id = ?').run('paid', reqId);
  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(req.amount, user.id);

  ctx.answerCbQuery('Marked as paid.');
  ctx.editMessageReplyMarkup();
  ctx.telegram.sendMessage(user.telegram_id, `💸 Your withdrawal of ${req.amount} has been paid!`).catch(() => {});
});
bot.hears('📋 Tasks', (ctx) => {
  const tasks = db.prepare(`SELECT * FROM tasks WHERE status = 'open' AND slots_filled < slots_total ORDER BY id DESC`).all();
  if (tasks.length === 0) return ctx.reply('No open tasks right now. Check back later!');
  tasks.forEach(task => {
    const slotsLeft = task.slots_total - task.slots_filled;
    ctx.reply(
      `📋 *${task.title}*\n\n${task.description}\n\n💰 Reward: ${task.reward}\n🎟 Slots left: ${slotsLeft}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([Markup.button.callback('✅ Do this task', `dotask_${task.id}`)]) }
    );
  });
});

bot.hears('💰 Balance', (ctx) => {
  const user = getOrCreateUser(ctx);
  ctx.reply(`💰 Your balance: ${user.balance}`);
});

bot.hears('💸 Withdraw', (ctx) => {
  const user = getOrCreateUser(ctx);
  if (user.balance <= 0) return ctx.reply('You have no balance to withdraw.');
  db.prepare('INSERT INTO withdrawals (user_id, amount) VALUES (?, ?)').run(user.id, user.balance);
  ctx.reply(`Withdrawal request for ${user.balance} submitted. You'll be paid once approved.`);
  for (const adminId of ADMIN_IDS) {
    ctx.telegram.sendMessage(adminId, `💸 New withdrawal request from @${user.username}: ${user.balance}\nUse /withdrawals to review.`).catch(() => {});
  }
});

bot.launch();
console.log('Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
  
