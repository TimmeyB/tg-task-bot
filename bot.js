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
const pendingWithdrawal = new Map();

function getOrCreateUserWithReferral(ctx) {
  const tgId = ctx.from.id;
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
  if (!user) {
    let referredBy = null;
    const payload = ctx.startPayload;
    if (payload && payload.startsWith('ref')) {
      const refTelegramId = payload.replace('ref', '');
      const refUser = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(refTelegramId);
      if (refUser && String(refUser.telegram_id) !== String(tgId)) {
        referredBy = refUser.telegram_id;
      }
    }
    db.prepare('INSERT INTO users (telegram_id, username, referred_by) VALUES (?, ?, ?)')
      .run(tgId, ctx.from.username || ctx.from.first_name || 'unknown', referredBy);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId);
  }
  return user;
}
bot.start((ctx) => {
  getOrCreateUserWithReferral(ctx);
  ctx.reply(
    `Welcome ${ctx.from.first_name}! 👋\n\nThis bot lets you earn money completing simple tasks.\n\nTap a button below anytime.\n\n💬 Join our community for updates & to connect with other users: https://t.me/+EEDVwNc2s345OGVk` +
    (isAdmin(ctx) ? `\n\nAdmin commands:\n/addtask - create a new task\n/pending - review submissions\n/withdrawals - review payout requests\n/broadcast - message all users` : ''),
    Markup.keyboard([
      ['📋 Tasks', '💰 Balance'],
      ['💸 Withdraw', '🔗 Referral'],
      ['💬 Community', '🆘 Support']
    ]).resize()
  );
});

bot.hears('💬 Community', (ctx) => {
  ctx.reply('Join our community here: https://t.me/+EEDVwNc2s345OGVk');
});

bot.hears('🆘 Support', (ctx) => {
  ctx.reply('Having an issue? Message the admin directly: @Skiiddd');
});
bot.command('referral', (ctx) => {
  const user = getOrCreateUser(ctx);
  ctx.telegram.getMe().then(me => {
    const link = `https://t.me/${me.username}?start=ref${user.telegram_id}`;
    const activeCount = db.prepare(`
      SELECT COUNT(DISTINCT u.telegram_id) as count
      FROM users u
      JOIN submissions s ON s.user_id = u.id
      WHERE u.referred_by = ? AND s.status = 'approved'
    `).get(user.telegram_id).count;
    const nextMilestone = (Math.floor(activeCount / 10) + 1) * 10;
    ctx.reply(
      `🔗 Your referral link:\n${link}\n\n👥 Active referrals: ${activeCount}\n🎯 Next $1 bonus at: ${nextMilestone} active referrals\n\n(An "active" referral is someone who joined with your link AND had at least 1 task approved)`
    );
  });
});

bot.hears('🔗 Referral', (ctx) => {
  const user = getOrCreateUser(ctx);
  ctx.telegram.getMe().then(me => {
    const link = `https://t.me/${me.username}?start=ref${user.telegram_id}`;
    const activeCount = db.prepare(`
      SELECT COUNT(DISTINCT u.telegram_id) as count
      FROM users u
      JOIN submissions s ON s.user_id = u.id
      WHERE u.referred_by = ? AND s.status = 'approved'
    `).get(user.telegram_id).count;
    const nextMilestone = (Math.floor(activeCount / 10) + 1) * 10;
    ctx.reply(
      `🔗 Your referral link:\n${link}\n\n👥 Active referrals: ${activeCount}\n🎯 Next $1 bonus at: ${nextMilestone} active referrals\n\n(An "active" referral is someone who joined with your link AND had at least 1 task approved)`
    );
  });
});

bot.command('tasks', (ctx) => {
  const user = getOrCreateUser(ctx);
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'open' AND slots_filled < slots_total
    AND id NOT IN (SELECT task_id FROM submissions WHERE user_id = ? AND status != 'rejected')
    ORDER BY id DESC
  `).all(user.id);
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
  const user = getOrCreateUser(ctx);
  const existing = db.prepare(`SELECT * FROM submissions WHERE task_id = ? AND user_id = ? AND status != 'rejected'`).get(taskId, user.id);
  if (existing) {
    return ctx.answerCbQuery('You already submitted this task.', { show_alert: true });
  }
  pendingSubmission.set(ctx.from.id, { taskId, expiresAt: Date.now() + 2 * 60 * 60 * 1000 });
  ctx.answerCbQuery();
  ctx.reply(`Got it. Complete the task, then send me a screenshot as proof (just send the photo here). You have 2 hours before this expires.`);
});
bot.on('photo', async (ctx) => {
  const pending = pendingSubmission.get(ctx.from.id);
  if (!pending) return;
  if (Date.now() > pending.expiresAt) {
    pendingSubmission.delete(ctx.from.id);
    return ctx.reply('This task claim expired. Tap "Do this task" again to retry.');
  }
  const taskId = pending.taskId;

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
  bot.command('withdraw', (ctx) => {
  const user = getOrCreateUser(ctx);
  if (user.balance <= 0) return ctx.reply('You have no balance to withdraw.');
  const existingPending = db.prepare(`SELECT * FROM withdrawals WHERE user_id = ? AND status = 'pending'`).get(user.id);
  if (existingPending) {
    return ctx.reply('You already have a pending withdrawal request. Please wait until it\'s processed before requesting another.');
  }
  pendingWithdrawal.set(ctx.from.id, { step: 'amount' });
  ctx.reply(`Your balance: ${user.balance}\n\nHow much would you like to withdraw?`);
});
bot.command('addtask', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  pendingTaskCreation.set(ctx.from.id, { step: 'title' });
  ctx.reply('Let\'s create a task. Send the task TITLE:');
});bot.on('text', (ctx, next) => {
  const withdrawState = pendingWithdrawal.get(ctx.from.id);
  if (withdrawState) {
    const user = getOrCreateUser(ctx);

    if (withdrawState.step === 'amount') {
      const amount = parseFloat(ctx.message.text.trim());
      if (isNaN(amount) || amount <= 0) {
        return ctx.reply('Please enter a valid positive number.');
      }
      if (amount > user.balance) {
        return ctx.reply(`You only have ${user.balance} available. Please enter a smaller amount.`);
      }
      withdrawState.step = 'wallet';
      withdrawState.amount = amount;
      pendingWithdrawal.set(ctx.from.id, withdrawState);
      return ctx.reply('Please send your Solana (SOL) wallet address to receive payment:');
    }

    if (withdrawState.step === 'wallet') {
      const walletAddress = ctx.message.text.trim();
      const amount = withdrawState.amount;
      pendingWithdrawal.delete(ctx.from.id);
      db.prepare('INSERT INTO withdrawals (user_id, amount, wallet_address) VALUES (?, ?, ?)').run(user.id, amount, walletAddress);
      ctx.reply(`Withdrawal request for ${amount} submitted to wallet ${walletAddress}. You'll be paid once approved.`);
      for (const adminId of ADMIN_IDS) {
        ctx.telegram.sendMessage(adminId, `💸 New withdrawal request from @${user.username}: ${amount}\nWallet: ${walletAddress}\nUse /withdrawals to review.`).catch(() => {});
      }
      return;
    }
  }

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

  if (user.referred_by) {
    const referrer = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(user.referred_by);
    if (referrer) {
      const activeCount = db.prepare(`
        SELECT COUNT(DISTINCT u.telegram_id) as count
        FROM users u
        JOIN submissions s ON s.user_id = u.id
        WHERE u.referred_by = ? AND s.status = 'approved'
      `).get(referrer.telegram_id).count;

      const milestonesEarned = Math.floor(activeCount / 10);
      if (milestonesEarned > referrer.referral_milestones_paid) {
        const newBonuses = milestonesEarned - referrer.referral_milestones_paid;
        const bonusAmount = newBonuses * 1;
        db.prepare('UPDATE users SET balance = balance + ?, referral_milestones_paid = ? WHERE id = ?')
          .run(bonusAmount, milestonesEarned, referrer.id);
        ctx.telegram.sendMessage(referrer.telegram_id, `🎉 Referral bonus! You've hit ${milestonesEarned * 10} active referrals — +$${bonusAmount} added to your balance!`).catch(() => {});
      }
    }
  }
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
bot.command('broadcast', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const message = ctx.message.text.replace('/broadcast', '').trim();
  if (!message) return ctx.reply('Usage: /broadcast <your message>');

  const users = db.prepare('SELECT telegram_id FROM users').all();
  let sent = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await bot.telegram.sendMessage(u.telegram_id, `📢 ${message}`);
      sent++;
    } catch (e) {
      failed++;
    }
  }
  ctx.reply(`Broadcast sent to ${sent} users. Failed: ${failed}.`);
});

bot.command('alltasks', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY id DESC').all();
  if (tasks.length === 0) return ctx.reply('No tasks created yet.');

  tasks.forEach(task => {
    const slotsLeft = task.slots_total - task.slots_filled;
    ctx.reply(
      `#${task.id} — ${task.title}\nStatus: ${task.status}\nSlots: ${task.slots_filled}/${task.slots_total} (${slotsLeft} left)\nReward: ${task.reward}`,
      Markup.inlineKeyboard([
        Markup.button.callback('🗑 Delete this task', `deltask_${task.id}`)
      ])
    );
  });
});

bot.action(/deltask_(\d+)/, (ctx) => {
  if (!isAdmin(ctx)) return ctx.answerCbQuery('Not authorized.');
  const taskId = Number(ctx.match[1]);
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (!task) return ctx.answerCbQuery('Task not found or already deleted.');

  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('closed', taskId);
  ctx.answerCbQuery('Task closed.');
  ctx.editMessageReplyMarkup();
  ctx.reply(`✅ Task "${task.title}" has been closed and removed from active listings.`);
});

bot.command('users', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const users = db.prepare('SELECT telegram_id, username, balance FROM users ORDER BY id DESC').all();
  if (users.length === 0) return ctx.reply('No users yet.');

  let message = `👥 Total users: ${users.length}\n\n`;
  users.forEach(u => {
    message += `@${u.username} — id: ${u.telegram_id} — balance: ${u.balance}\n`;
  });

  if (message.length > 4000) {
    const chunks = message.match(/[\s\S]{1,4000}/g);
    chunks.forEach(chunk => ctx.reply(chunk));
  } else {
    ctx.reply(message);
  }
});


bot.command('withdrawals', (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const reqs = db.prepare(`
    SELECT withdrawals.id, withdrawals.amount, withdrawals.wallet_address, users.username, users.telegram_id
    FROM withdrawals JOIN users ON withdrawals.user_id = users.id
    WHERE withdrawals.status = 'pending'
    ORDER BY withdrawals.id ASC
  `).all();
  if (reqs.length === 0) return ctx.reply('No pending withdrawals.');
  reqs.forEach(r => {
    ctx.reply(
      `#${r.id} — @${r.username} — ${r.amount}\nWallet: ${r.wallet_address || 'N/A'}`,
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
  const user = getOrCreateUser(ctx);
  const tasks = db.prepare(`
    SELECT * FROM tasks
    WHERE status = 'open' AND slots_filled < slots_total
    AND id NOT IN (SELECT task_id FROM submissions WHERE user_id = ? AND status != 'rejected')
    ORDER BY id DESC
  `).all(user.id);
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
  const existingPending = db.prepare(`SELECT * FROM withdrawals WHERE user_id = ? AND status = 'pending'`).get(user.id);
  if (existingPending) {
    return ctx.reply('You already have a pending withdrawal request. Please wait until it\'s processed before requesting another.');
  }
  pendingWithdrawal.set(ctx.from.id, { step: 'amount' });
  ctx.reply(`Your balance: ${user.balance}\n\nHow much would you like to withdraw?`);
});

setInterval(() => {
  const now = Date.now();
  for (const [telegramId, pending] of pendingSubmission.entries()) {
    if (now > pending.expiresAt) {
      pendingSubmission.delete(telegramId);
      bot.telegram.sendMessage(telegramId, '⏰ Your task claim expired after 2 hours since no proof was submitted. Tap "Do this task" again if you still want to complete it.').catch(() => {});
    }
  }
}, 5 * 60 * 1000);

bot.launch();

console.log('Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
  
