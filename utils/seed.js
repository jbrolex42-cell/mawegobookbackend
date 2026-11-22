/**
 * Seed categories, admin user, and sample products into MongoDB
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const bcrypt = require('bcryptjs');
const { connectMongo } = require('../config/mongo');
const {
  User,
  Category,
  Product,
  StockLedger,
  DeliveryZone,
  Setting
} = require('../models');
const { slugify } = require('./helpers');

const ALL_CATEGORIES = [
  { name: 'Textbooks', slug: 'textbooks', description: 'Curriculum and academic textbooks', sort_order: 1 },
  { name: 'Storybooks & Fiction', slug: 'storybooks-fiction', description: 'Novels and fiction', sort_order: 2 },
  { name: 'Stationery', slug: 'stationery', description: 'Pens, books, files', sort_order: 3 },
  { name: 'Revision & Exam Guides', slug: 'revision-exam-guides', description: 'KCPE, KCSE revision', sort_order: 4 },
  { name: 'Children & Early Learning', slug: 'children-early-learning', description: 'Early readers', sort_order: 5 },
  { name: 'Religious & Spiritual', slug: 'religious-spiritual', description: 'Bibles and spiritual books', sort_order: 6 },
  { name: 'General Interest', slug: 'general-interest', description: 'Magazines and biographies', sort_order: 7 },
  { name: 'TVET Course Materials', slug: 'tvet-course-materials', description: 'TVET module notes', sort_order: 8 },
  { name: 'Engineering & Technical', slug: 'engineering-technical', description: 'Engineering texts', sort_order: 9 },
  { name: 'ICT & Computing', slug: 'ict-computing', description: 'IT and programming', sort_order: 10 },
  { name: 'Business & Accounting', slug: 'business-accounting', description: 'Business and accounting', sort_order: 11 },
  { name: 'Health Sciences', slug: 'health-sciences', description: 'Nursing and health', sort_order: 12 },
  { name: 'Agriculture & Environment', slug: 'agriculture-environment', description: 'Agriculture studies', sort_order: 13 },
  { name: 'Hospitality & Tourism', slug: 'hospitality-tourism', description: 'Hospitality studies', sort_order: 14 },
  { name: 'Education & Teaching', slug: 'education-teaching', description: 'Teacher training', sort_order: 15 },
  { name: 'University Textbooks', slug: 'university-textbooks', description: 'Degree-level textbooks', sort_order: 16 },
  { name: 'Law & Social Sciences', slug: 'law-social-sciences', description: 'Law and social sciences', sort_order: 17 }
];

const PRODUCTS = [
  { sku: 'TB-MATH-F1', name: 'Secondary Mathematics Form 1', category: 'textbooks', price: 850, cost: 550, stock: 40, desc: 'KICD approved Form 1 Mathematics.' },
  { sku: 'TB-ENG-F2', name: 'English Form 2 Student Book', category: 'textbooks', price: 780, cost: 500, stock: 35, desc: 'Form 2 English course book.' },
  { sku: 'ST-RIVER', name: 'The River and the Source', category: 'storybooks-fiction', price: 650, cost: 400, stock: 50, desc: 'Classic Kenyan novel.' },
  { sku: 'STN-EXB-A4', name: 'A4 Exercise Book 200 Pages', category: 'stationery', price: 120, cost: 70, stock: 200, desc: 'Ruled exercise book.' },
  { sku: 'STN-PEN-BLUE', name: 'Blue Ballpoint Pens (Pack of 10)', category: 'stationery', price: 150, cost: 80, stock: 150, desc: 'Ballpoint pens.' },
  { sku: 'REV-KCSE-MATH', name: 'KCSE Mathematics Revision Guide', category: 'revision-exam-guides', price: 1100, cost: 700, stock: 25, desc: 'KCSE Math past papers.' },
  { sku: 'CH-ABC', name: 'My First ABC Book', category: 'children-early-learning', price: 280, cost: 150, stock: 80, desc: 'Alphabet picture book.' },
  { sku: 'REL-BIBLE', name: 'Holy Bible (NIV)', category: 'religious-spiritual', price: 1200, cost: 800, stock: 40, desc: 'NIV Bible.' },
  { sku: 'TVET-ELEC-1', name: 'Electrical Installation Level 5 Module', category: 'tvet-course-materials', price: 980, cost: 620, stock: 30, desc: 'TVET electrical module.' },
  { sku: 'ICT-PYTHON', name: 'Introduction to Python Programming', category: 'ict-computing', price: 1450, cost: 900, stock: 25, desc: 'Python for college ICT.' },
  { sku: 'BUS-ACC-1', name: 'Financial Accounting for Colleges', category: 'business-accounting', price: 1320, cost: 850, stock: 28, desc: 'College accounting text.' },
  { sku: 'HEA-NUR-1', name: 'Fundamentals of Nursing Practice', category: 'health-sciences', price: 2100, cost: 1400, stock: 15, desc: 'Nursing fundamentals.' },
  { sku: 'UNI-CALC', name: 'University Calculus Volume 1', category: 'university-textbooks', price: 2850, cost: 1900, stock: 12, desc: 'First-year calculus.' },
  { sku: 'LAW-INTRO', name: 'Introduction to Kenyan Law', category: 'law-social-sciences', price: 1750, cost: 1100, stock: 14, desc: 'Intro law text.' }
];

async function seed() {
  await connectMongo();
  console.log('Seeding Mawego Bookshop...');

  for (const c of ALL_CATEGORIES) {
    await Category.updateOne(
      { slug: c.slug },
      { $setOnInsert: { ...c, is_active: true } },
      { upsert: true }
    );
  }
  console.log('Categories ready');

  const email = (process.env.ADMIN_EMAIL || 'admin@mawego.bookshop').toLowerCase();
  let owner = await User.findOne({ email });
  if (!owner) {
    owner = await User.create({
      email,
      password_hash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'MawegoAdmin2024!', 10),
      full_name: process.env.ADMIN_NAME || 'Shop Owner',
      role: 'owner',
      permissions: ['*'],
      is_active: true
    });
    console.log('Owner created:', email);
  } else {
    console.log('Owner already exists:', email);
  }

  if ((await DeliveryZone.countDocuments()) === 0) {
    await DeliveryZone.create([
      { name: 'Mawego & nearby', fee_kes: 200, min_order_kes: 0, is_active: true },
      { name: 'Homa Bay town', fee_kes: 350, min_order_kes: 0, is_active: true }
    ]);
  }

  const defaultSettings = {
    shop_name: 'Mawego Bookshop',
    currency: 'KES',
    default_delivery_fee: '200',
    free_delivery_threshold: '2000',
    shop_phone: '+254700000000',
    shop_address: 'Mawego, Kenya',
    shop_email: 'info@mawego.bookshop',
    receipt_footer: 'Thank you for shopping at Mawego Bookshop'
  };
  for (const [key, value] of Object.entries(defaultSettings)) {
    await Setting.updateOne({ key }, { $setOnInsert: { key, value, updated_at: new Date() } }, { upsert: true });
  }

  const cats = await Category.find();
  const catMap = {};
  cats.forEach((c) => {
    catMap[c.slug] = c._id;
  });

  let added = 0;
  for (const p of PRODUCTS) {
    if (await Product.findOne({ sku: p.sku })) continue;
    const product = await Product.create({
      sku: p.sku,
      barcode: p.sku,
      name: p.name,
      slug: slugify(p.name),
      description: p.desc,
      category_id: catMap[p.category] || null,
      price_kes: p.price,
      cost_kes: p.cost,
      stock_qty: p.stock,
      low_stock_threshold: 5,
      is_active: true
    });
    await StockLedger.create({
      product_id: product._id,
      change_qty: p.stock,
      balance_after: p.stock,
      reason: 'initial_stock',
      reference_type: 'seed',
      notes: 'Seed data'
    });
    added++;
  }
  console.log(`Products added: ${added}`);
  console.log('Seed complete.');
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
