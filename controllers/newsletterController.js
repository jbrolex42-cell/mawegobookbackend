
'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const {
  NewsletterSubscriber,
  NewsletterCampaign
} = require('../models');

const {
  sendNewsletterEmail,
  newsletterEmailLayout,
  escapeHtml
} = require('../services/newsletterEmailService');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const TOKEN_EXPIRY_HOURS = 24;

const PUBLIC_API_URL = (
  process.env.NEWSLETTER_PUBLIC_API_URL ||
  process.env.API_PUBLIC_URL ||
  'http://localhost:3000/api'
).replace(/\/+$/, '');

const hashToken = (token) =>
  crypto.createHash('sha256').update(token).digest('hex');

const createToken = () =>
  crypto.randomBytes(32).toString('hex');

// Stable unsubscribe token. It can be regenerated for every campaign
// without storing the original token in plain text.
const createUnsubscribeToken = (subscriber) => {
  const secret =
    process.env.NEWSLETTER_UNSUBSCRIBE_SECRET ||
    process.env.JWT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      'Configure NEWSLETTER_UNSUBSCRIBE_SECRET with at least 32 characters.'
    );
  }

  return crypto
    .createHmac('sha256', secret)
    .update(`${subscriber._id}:${subscriber.email}`)
    .digest('hex');
};

const verificationUrl = (token) =>
  `${PUBLIC_API_URL}/newsletter/verify?token=${encodeURIComponent(token)}`;

const unsubscribeUrl = (token) =>
  `${PUBLIC_API_URL}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`;

const successMessage = (message) => `
  <h2 style="color:#087653;">${escapeHtml(message)}</h2>
  <p>You can close this page.</p>
`;

const htmlPage = (content) => `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mawego Bookshop</title>
  </head>
  <body style="margin:0;padding:35px 15px;background:#f4f7f5;font-family:Arial,sans-serif;">
    <main style="max-width:520px;margin:auto;padding:30px;background:#fff;border-radius:12px;text-align:center;color:#26352e;">
      <h1 style="color:#087653;">Mawego Bookshop</h1>
      ${content}
    </main>
  </body>
  </html>
`;

const sendVerificationEmail = async (subscriber, token) => {
  const url = verificationUrl(token);

  const html = newsletterEmailLayout(`
    <h2>Confirm your subscription</h2>
    <p>Thank you for joining the Mawego Bookshop newsletter.</p>
    <p>Please confirm your email address by clicking the button below.</p>

    <p style="text-align:center;margin:30px 0;">
      <a href="${url}"
         style="display:inline-block;background:#087653;color:#fff;padding:14px 25px;border-radius:7px;text-decoration:none;font-weight:bold;">
        Confirm my subscription
      </a>
    </p>

    <p>If you did not request this subscription, you can ignore this email.</p>
    <p>This confirmation link expires in ${TOKEN_EXPIRY_HOURS} hours.</p>
  `);

  await sendNewsletterEmail({
    to: subscriber.email,
    subject: 'Confirm your Mawego Bookshop newsletter subscription',
    html,
    text: `Confirm your subscription: ${url}`
  });
};

const sendWelcomeEmail = async (subscriber) => {
  const token = createUnsubscribeToken(subscriber);
  const url = unsubscribeUrl(token);

  const html = newsletterEmailLayout(`
    <h2>Welcome to Mawego Bookshop!</h2>
    <p>Your email address has been verified successfully.</p>
    <p>Thank you for subscribing. We look forward to sharing new arrivals, learning resources and bookshop updates with you.</p>
    <p>Keep discovering. Keep learning!</p>
    <p style="margin-top:30px;font-size:12px;color:#64736b;">
      <a href="${url}">Unsubscribe from our newsletter</a>
    </p>
  `);

  await sendNewsletterEmail({
    to: subscriber.email,
    subject: 'Welcome to Mawego Bookshop',
    html,
    text: `Welcome to Mawego Bookshop! Unsubscribe: ${url}`
  });
};

// POST /api/newsletter/subscribe
exports.subscribe = async (req, res) => {
  try {
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();

    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return res.status(400).json({
        error: 'Please provide a valid email address.'
      });
    }

    let subscriber = await NewsletterSubscriber.findOne({ email })
      .select('+verification_token_hash +unsubscribe_token_hash');

    if (subscriber?.status === 'active') {
      return res.status(200).json({
        message: 'Thank you. If confirmation is required, please check your email.'
      });
    }

    const verificationToken = createToken();

    if (!subscriber) {
      subscriber = new NewsletterSubscriber({
        email,
        status: 'pending',
        source: 'website',
        consent_at: new Date()
      });
    }

    subscriber.status = 'pending';
    subscriber.verification_token_hash = hashToken(verificationToken);
    subscriber.verification_expires_at = new Date(
      Date.now() + TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
    );

    subscriber.unsubscribe_token_hash = hashToken(
      createUnsubscribeToken(subscriber)
    );

    await subscriber.save();

    await sendVerificationEmail(subscriber, verificationToken);

    return res.status(200).json({
      message: 'Please check your email to confirm your newsletter subscription.'
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(200).json({
        message: 'Thank you. If confirmation is required, please check your email.'
      });
    }

    console.error('[Newsletter] Subscription error:', error);

    return res.status(500).json({
      error: 'Unable to process your subscription right now. Please try again later.'
    });
  }
};

// GET /api/newsletter/verify?token=...
exports.verifySubscription = async (req, res) => {
  try {
    const token = String(req.query.token || '');

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).send(
        htmlPage('<h2>Invalid verification link</h2><p>Please subscribe again.</p>')
      );
    }

    const subscriber = await NewsletterSubscriber.findOne({
      verification_token_hash: hashToken(token),
      verification_expires_at: { $gt: new Date() },
      status: 'pending'
    }).select('+verification_token_hash +unsubscribe_token_hash');

    if (!subscriber) {
      return res.status(400).send(
        htmlPage('<h2>Link expired or already used</h2><p>Please subscribe again to receive a new confirmation link.</p>')
      );
    }

    subscriber.status = 'active';
    subscriber.verified_at = new Date();
    subscriber.verification_token_hash = null;
    subscriber.verification_expires_at = null;

    await subscriber.save();

    try {
      await sendWelcomeEmail(subscriber);
    } catch (emailError) {
      console.error('[Newsletter] Welcome email error:', emailError.message);
    }

    return res.status(200).send(
      htmlPage(successMessage('Your subscription is confirmed!'))
    );
  } catch (error) {
    console.error('[Newsletter] Verification error:', error);

    return res.status(500).send(
      htmlPage('<h2>Something went wrong</h2><p>Please try again later.</p>')
    );
  }
};

// GET /api/newsletter/unsubscribe?token=...
// GET displays a confirmation form. It does not unsubscribe automatically.
exports.showUnsubscribe = async (req, res) => {
  const token = String(req.query.token || '');

  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).send(
      htmlPage('<h2>Invalid unsubscribe link</h2>')
    );
  }

  return res.status(200).send(htmlPage(`
    <h2>Unsubscribe from our newsletter?</h2>
    <p>We are sorry to see you go. Confirm below if you no longer want to receive our emails.</p>

    <form method="POST" action="${PUBLIC_API_URL}/newsletter/unsubscribe">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button type="submit"
        style="background:#087653;color:#fff;border:0;border-radius:7px;padding:13px 24px;cursor:pointer;">
        Confirm unsubscribe
      </button>
    </form>
  `));
};

// POST /api/newsletter/unsubscribe
exports.unsubscribe = async (req, res) => {
  try {
    const token = String(req.body.token || '');

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).send(
        htmlPage('<h2>Invalid unsubscribe link</h2>')
      );
    }

    const subscriber = await NewsletterSubscriber.findOne({
      unsubscribe_token_hash: hashToken(token),
      status: 'active'
    }).select('+unsubscribe_token_hash');

    if (!subscriber) {
      return res.status(200).send(
        htmlPage(successMessage('You are already unsubscribed or the link is invalid.'))
      );
    }

    subscriber.status = 'unsubscribed';
    subscriber.unsubscribed_at = new Date();

    await subscriber.save();

    return res.status(200).send(
      htmlPage(successMessage('You have been unsubscribed successfully.'))
    );
  } catch (error) {
    console.error('[Newsletter] Unsubscribe error:', error);

    return res.status(500).send(
      htmlPage('<h2>Unable to unsubscribe</h2><p>Please try again later.</p>')
    );
  }
};

// GET /api/newsletter/admin/stats
exports.getStats = async (req, res) => {
  try {
    const [active, pending, unsubscribed, campaigns] = await Promise.all([
      NewsletterSubscriber.countDocuments({ status: 'active' }),
      NewsletterSubscriber.countDocuments({ status: 'pending' }),
      NewsletterSubscriber.countDocuments({ status: 'unsubscribed' }),
      NewsletterCampaign.countDocuments()
    ]);

    return res.json({
      subscribers: {
        active,
        pending,
        unsubscribed,
        total: active + pending + unsubscribed
      },
      campaigns
    });
  } catch (error) {
    console.error('[Newsletter] Stats error:', error);

    return res.status(500).json({
      error: 'Unable to load newsletter statistics.'
    });
  }
};

// GET /api/newsletter/admin/subscribers
exports.getSubscribers = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();

    const filter = {};

    if (['pending', 'active', 'unsubscribed'].includes(status)) {
      filter.status = status;
    }

    if (search) {
      filter.email = { $regex: search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    }

    const [subscribers, total] = await Promise.all([
      NewsletterSubscriber.find(filter)
        .select('email status source consent_at verified_at unsubscribed_at created_at')
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      NewsletterSubscriber.countDocuments(filter)
    ]);

    return res.json({
      subscribers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[Newsletter] Subscriber listing error:', error);

    return res.status(500).json({
      error: 'Unable to load subscribers.'
    });
  }
};

// POST /api/newsletter/admin/campaigns
exports.createCampaign = async (req, res) => {
  try {
    const subject = String(req.body.subject || '').trim();
    const previewText = String(req.body.preview_text || '').trim();
    const content = String(req.body.content || '').trim();

    if (!subject || subject.length > 200) {
      return res.status(400).json({
        error: 'A subject between 1 and 200 characters is required.'
      });
    }

    if (!content || content.length > 50000) {
      return res.status(400).json({
        error: 'Campaign content is required and must not exceed 50,000 characters.'
      });
    }

    if (previewText.length > 250) {
      return res.status(400).json({
        error: 'Preview text cannot exceed 250 characters.'
      });
    }

    const campaign = await NewsletterCampaign.create({
      subject,
      preview_text: previewText,
      content,
      status: 'draft',
      created_by: req.user.id
    });

    return res.status(201).json({
      message: 'Newsletter campaign saved as a draft.',
      campaign
    });
  } catch (error) {
    console.error('[Newsletter] Campaign creation error:', error);

    return res.status(500).json({
      error: 'Unable to create campaign.'
    });
  }
};

// GET /api/newsletter/admin/campaigns
exports.getCampaigns = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const [campaigns, total] = await Promise.all([
      NewsletterCampaign.find()
        .sort({ created_at: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),

      NewsletterCampaign.countDocuments()
    ]);

    return res.json({
      campaigns,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('[Newsletter] Campaign listing error:', error);

    return res.status(500).json({
      error: 'Unable to load campaigns.'
    });
  }
};

// POST /api/newsletter/admin/campaigns/:id/send
exports.sendCampaign = async (req, res) => {
  let campaign;

  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        error: 'Invalid campaign ID.'
      });
    }

    campaign = await NewsletterCampaign.findById(req.params.id);

    if (!campaign) {
      return res.status(404).json({
        error: 'Campaign not found.'
      });
    }

    if (campaign.status !== 'draft') {
      return res.status(409).json({
        error: 'Only draft campaigns can be sent.'
      });
    }

    const subscribers = await NewsletterSubscriber.find({
      status: 'active'
    }).select('email status');

    if (!subscribers.length) {
      return res.status(400).json({
        error: 'There are no active subscribers to receive this campaign.'
      });
    }

    campaign.status = 'sending';
    campaign.recipient_count = subscribers.length;
    campaign.sent_count = 0;
    campaign.failed_count = 0;
    campaign.started_at = new Date();
    campaign.failure_reason = '';

    await campaign.save();

    // Process in small batches to avoid overwhelming the email provider.
    const batchSize = 10;
    const safeContent = escapeHtml(campaign.content).replace(/\n/g, '<br>');

    for (let i = 0; i < subscribers.length; i += batchSize) {
      const batch = subscribers.slice(i, i + batchSize);

      const results = await Promise.allSettled(
        batch.map(async (subscriber) => {
          const token = createUnsubscribeToken(subscriber);
          const url = unsubscribeUrl(token);

          const html = newsletterEmailLayout(`
            ${campaign.preview_text
              ? `<p style="color:#64736b;">${escapeHtml(campaign.preview_text)}</p>`
              : ''
            }
            <h2>${escapeHtml(campaign.subject)}</h2>
            <div style="line-height:1.8;">${safeContent}</div>

            <hr style="margin:30px 0;border:0;border-top:1px solid #e5eae7;">

            <p style="font-size:12px;color:#64736b;">
              You are receiving this email because you subscribed to Mawego Bookshop.
              <a href="${url}">Unsubscribe</a>
            </p>
          `);

          await sendNewsletterEmail({
            to: subscriber.email,
            subject: campaign.subject,
            html,
            text: `${campaign.content}\n\nUnsubscribe: ${url}`
          });

          return subscriber._id;
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          campaign.sent_count += 1;
        } else {
          campaign.failed_count += 1;

          console.error(
            '[Newsletter] Campaign delivery failure:',
            result.reason?.message
          );
        }
      }

      campaign.last_batch_at = new Date();
      await campaign.save();
    }

    campaign.status = 'sent';
    campaign.completed_at = new Date();

    if (campaign.failed_count > 0) {
      campaign.failure_reason =
        `${campaign.failed_count} email(s) could not be delivered.`;
    }

    await campaign.save();

    return res.json({
      message: 'Campaign sending process completed.',
      campaign: {
        id: campaign._id,
        status: campaign.status,
        recipient_count: campaign.recipient_count,
        sent_count: campaign.sent_count,
        failed_count: campaign.failed_count
      }
    });
  } catch (error) {
    console.error('[Newsletter] Campaign sending error:', error);

    if (campaign) {
      campaign.status = 'failed';
      campaign.failure_reason = String(error.message || 'Campaign sending failed').slice(0, 2000);
      campaign.completed_at = new Date();

      await campaign.save().catch((saveError) => {
        console.error('[Newsletter] Could not save campaign failure:', saveError);
      });
    }

    return res.status(500).json({
      error: 'Campaign sending failed. Check the campaign record and server logs.'
    });
  }
};