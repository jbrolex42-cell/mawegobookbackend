const db = require('../config/db');
const bcrypt = require('bcryptjs');
const path = require('path');

/** All catalogue categories — primary school through TVET & university */
const ALL_CATEGORIES = [
  { name: 'Textbooks', slug: 'textbooks', description: 'Curriculum and academic textbooks (primary & secondary)', sort_order: 1, is_active: 1 },
  { name: 'Storybooks & Fiction', slug: 'storybooks-fiction', description: 'Novels, short stories and fiction', sort_order: 2, is_active: 1 },
  { name: 'Stationery', slug: 'stationery', description: 'Pens, books, files and office supplies', sort_order: 3, is_active: 1 },
  { name: 'Revision & Exam Guides', slug: 'revision-exam-guides', description: 'KCPE, KCSE and other revision materials', sort_order: 4, is_active: 1 },
  { name: 'Children & Early Learning', slug: 'children-early-learning', description: 'Picture books and early readers', sort_order: 5, is_active: 1 },
  { name: 'Religious & Spiritual', slug: 'religious-spiritual', description: 'Bibles, hymnals and spiritual books', sort_order: 6, is_active: 1 },
  { name: 'General Interest', slug: 'general-interest', description: 'Magazines, biographies and general reading', sort_order: 7, is_active: 1 },
  // TVET & university
  { name: 'TVET Course Materials', slug: 'tvet-course-materials', description: 'Module notes, workbooks and course packs for TVET colleges', sort_order: 8, is_active: 1 },
  { name: 'Engineering & Technical', slug: 'engineering-technical', description: 'Mechanical, electrical, civil and automotive engineering texts', sort_order: 9, is_active: 1 },
  { name: 'ICT & Computing', slug: 'ict-computing', description: 'Computer studies, programming, networking and IT certification guides', sort_order: 10, is_active: 1 },
  { name: 'Business & Accounting', slug: 'business-accounting', description: 'Business studies, accounting, entrepreneurship and management', sort_order: 11, is_active: 1 },
  { name: 'Health Sciences', slug: 'health-sciences', description: 'Nursing, clinical medicine, pharmacy and public health materials', sort_order: 12, is_active: 1 },
  { name: 'Agriculture & Environment', slug: 'agriculture-environment', description: 'Agriculture, agribusiness and environmental studies', sort_order: 13, is_active: 1 },
  { name: 'Hospitality & Tourism', slug: 'hospitality-tourism', description: 'Food production, hotel management and tourism studies', sort_order: 14, is_active: 1 },
  { name: 'Education & Teaching', slug: 'education-teaching', description: 'Teacher training, pedagogy and education studies', sort_order: 15, is_active: 1 },
  { name: 'University Textbooks', slug: 'university-textbooks', description: 'Degree-level core and recommended university textbooks', sort_order: 16, is_active: 1 },
  { name: 'Law & Social Sciences', slug: 'law-social-sciences', description: 'Law, sociology, psychology and related social science texts', sort_order: 17, is_active: 1 }
];

function ensureCategories() {
  const existing = db.all('categories');
  const bySlug = new Set(existing.map((c) => c.slug));
  let added = 0;
  for (const c of ALL_CATEGORIES) {
    if (!bySlug.has(c.slug)) {
      db.insert('categories', { ...c, created_at: db.now() });
      added++;
    }
  }
  if (added) console.log(`Added ${added} new categories.`);
}

function init() {
  console.log('Initializing Mawego Bookshop database...');

  ensureCategories();

  if (db.all('delivery_zones').length === 0) {
    db.insert('delivery_zones', { name: 'Mawego & nearby', fee_kes: 200, min_order_kes: 0, is_active: 1 });
    db.insert('delivery_zones', { name: 'Homa Bay town', fee_kes: 350, min_order_kes: 0, is_active: 1 });
  }

  if (db.all('settings').length === 0) {
    const settings = [
      ['shop_name', 'Mawego Bookshop'],
      ['currency', 'KES'],
      ['default_delivery_fee', '200'],
      ['free_delivery_threshold', '2000'],
      ['shop_phone', '+254700000000'],
      ['shop_address', 'Mawego, Kenya'],
      ['shop_email', 'info@mawego.bookshop'],
      ['receipt_footer', 'Thank you for shopping at Mawego Bookshop'],
      ['tax_rate_percent', '0'],
      ['facebook_url', 'https://facebook.com/'],
      ['whatsapp_url', 'https://wa.me/254700000000'],
      ['instagram_url', 'https://instagram.com/'],
      ['twitter_url', 'https://x.com/'],
      ['youtube_url', 'https://youtube.com/'],
      ['map_url', 'https://maps.google.com/?q=Mawego+Kenya']
    ];
    for (const [key, value] of settings) {
      db.insert('settings', { key, value, updated_at: db.now() });
    }
  } else {
    // Ensure social URL settings exist
    const socialDefaults = {
      facebook_url: 'https://facebook.com/',
      whatsapp_url: 'https://wa.me/254700000000',
      instagram_url: 'https://instagram.com/',
      twitter_url: 'https://x.com/',
      youtube_url: 'https://youtube.com/',
      map_url: 'https://maps.google.com/?q=Mawego+Kenya'
    };
    for (const [key, value] of Object.entries(socialDefaults)) {
      if (!db.get('settings', (s) => s.key === key)) {
        db.insert('settings', { key, value, updated_at: db.now() });
      }
    }
  }

  const owner = db.get('users', (u) => u.role === 'owner');
  if (!owner) {
    const email = process.env.ADMIN_EMAIL || 'admin@mawego.bookshop';
    const password = process.env.ADMIN_PASSWORD || 'MawegoAdmin2024!';
    const name = process.env.ADMIN_NAME || 'Shop Owner';
    db.insert('users', {
      email: email.toLowerCase(),
      password_hash: bcrypt.hashSync(password, 10),
      full_name: name,
      phone: null,
      role: 'owner',
      permissions: ['*'],
      is_active: 1,
      created_at: db.now(),
      updated_at: db.now()
    });
    console.log(`Default owner created: ${email}`);
  }

  console.log('Database initialized.');
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  init();
}

module.exports = { init, ensureCategories, ALL_CATEGORIES };
