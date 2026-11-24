
require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env')
});

const mongoose = require('mongoose');
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
  // GENERAL BOOKSHOP CATEGORIES
  {
    name: 'Textbooks',
    slug: 'textbooks',
    description: 'Curriculum and academic textbooks',
    sort_order: 1
  },
  {
    name: 'Storybooks & Fiction',
    slug: 'storybooks-fiction',
    description: 'Novels, short stories and fiction',
    sort_order: 2
  },
  {
    name: 'Stationery',
    slug: 'stationery',
    description: 'Exercise books, pens, files and office supplies',
    sort_order: 3
  },
  {
    name: 'Revision & Exam Guides',
    slug: 'revision-exam-guides',
    description: 'KCSE and other examination revision materials',
    sort_order: 4
  },
  {
    name: 'Children & Early Learning',
    slug: 'children-early-learning',
    description: 'Early readers, alphabet books and learning materials',
    sort_order: 5
  },
  {
    name: 'Religious & Spiritual',
    slug: 'religious-spiritual',
    description: 'Bibles and spiritual reading materials',
    sort_order: 6
  },
  {
    name: 'General Interest',
    slug: 'general-interest',
    description: 'Magazines, biographies and general reading',
    sort_order: 7
  },
  {
    name: 'TVET Course Materials',
    slug: 'tvet-course-materials',
    description: 'TVET modules and technical training materials',
    sort_order: 8
  },
  {
    name: 'Engineering & Technical',
    slug: 'engineering-technical',
    description: 'Engineering and technical textbooks',
    sort_order: 9
  },
  {
    name: 'ICT & Computing',
    slug: 'ict-computing',
    description: 'Computing, programming and information technology',
    sort_order: 10
  },
  {
    name: 'Business & Accounting',
    slug: 'business-accounting',
    description: 'Business management, finance and accounting',
    sort_order: 11
  },
  {
    name: 'Health Sciences',
    slug: 'health-sciences',
    description: 'Nursing, medicine and health science books',
    sort_order: 12
  },
  {
    name: 'Agriculture & Environment',
    slug: 'agriculture-environment',
    description: 'Agriculture, farming and environmental studies',
    sort_order: 13
  },
  {
    name: 'Hospitality & Tourism',
    slug: 'hospitality-tourism',
    description: 'Hospitality, catering and tourism materials',
    sort_order: 14
  },
  {
    name: 'Education & Teaching',
    slug: 'education-teaching',
    description: 'Teacher training and education materials',
    sort_order: 15
  },
  {
    name: 'University Textbooks',
    slug: 'university-textbooks',
    description: 'Degree-level and higher education textbooks',
    sort_order: 16
  },
  {
    name: 'Law & Social Sciences',
    slug: 'law-social-sciences',
    description: 'Law, history, politics and social sciences',
    sort_order: 17
  },

  // BUILDING, CONSTRUCTION AND CIVIL ENGINEERING
  {
    name: 'Building & Construction',
    slug: 'building-construction',
    description: 'Building technology, construction and site operations',
    sort_order: 18
  },
  {
    name: 'Architecture & Interior Design',
    slug: 'architecture-interior-design',
    description: 'Architecture, architectural design and interior decoration',
    sort_order: 19
  },
  {
    name: 'Civil & Structural Engineering',
    slug: 'civil-structural-engineering',
    description: 'Civil engineering, structural design and highway engineering',
    sort_order: 20
  },
  {
    name: 'Carpentry, Joinery & Furniture',
    slug: 'carpentry-joinery-furniture',
    description: 'Carpentry, joinery and furniture production',
    sort_order: 21
  },
  {
    name: 'Masonry, Plumbing & Building Services',
    slug: 'masonry-plumbing-building-services',
    description: 'Masonry, plumbing, painting and building services',
    sort_order: 22
  },

  // ENGINEERING AND INDUSTRIAL TECHNOLOGY
  {
    name: 'Automotive & Motor Vehicle Technology',
    slug: 'automotive-motor-vehicle',
    description: 'Automotive engineering, motor vehicle mechanics and autobody',
    sort_order: 23
  },
  {
    name: 'Electrical & Electronics Engineering',
    slug: 'electrical-electronics-engineering',
    description: 'Electrical installation, electronics and electrical engineering',
    sort_order: 24
  },
  {
    name: 'Telecommunications & Instrumentation',
    slug: 'telecommunications-instrumentation',
    description: 'Telecommunications, instrumentation and control engineering',
    sort_order: 25
  },
  {
    name: 'Refrigeration & Air Conditioning',
    slug: 'refrigeration-air-conditioning',
    description: 'Refrigeration, cooling systems and air conditioning',
    sort_order: 26
  },
  {
    name: 'Welding, Metalwork & Fabrication',
    slug: 'welding-metalwork-fabrication',
    description: 'Welding, metal processing, fabrication and fitting',
    sort_order: 27
  },
  {
    name: 'Manufacturing & Production Technology',
    slug: 'manufacturing-production-technology',
    description: 'Manufacturing, industrial production and machining',
    sort_order: 28
  },
  {
    name: 'Marine & Aeronautical Engineering',
    slug: 'marine-aeronautical-engineering',
    description: 'Marine engineering, aviation and aeronautical technology',
    sort_order: 29
  },

  // FASHION, BEAUTY AND CREATIVE ARTS
  {
    name: 'Fashion, Textile & Garment Technology',
    slug: 'fashion-textile-garment-technology',
    description: 'Fashion design, dressmaking, garment making and textile technology',
    sort_order: 30
  },
  {
    name: 'Hairdressing, Beauty & Cosmetology',
    slug: 'hairdressing-beauty-cosmetology',
    description: 'Hairdressing, beauty therapy, salon management and cosmetology',
    sort_order: 31
  },
  {
    name: 'Art, Graphic Design & Printing',
    slug: 'art-graphic-design-printing',
    description: 'Fine art, graphic design, printing and visual communication',
    sort_order: 32
  },
  {
    name: 'Leatherwork & Tannery Technology',
    slug: 'leatherwork-tannery-technology',
    description: 'Leather production, leather products and tannery technology',
    sort_order: 33
  },

  // FOOD AND HOSPITALITY
  {
    name: 'Food Science & Technology',
    slug: 'food-science-technology',
    description: 'Food science, food processing and preservation',
    sort_order: 34
  },
  {
    name: 'Baking, Pastry & Confectionery',
    slug: 'baking-pastry-confectionery',
    description: 'Baking, pastry production and confectionery',
    sort_order: 35
  },

  // AGRICULTURE AND NATURAL RESOURCES
  {
    name: 'Animal Health & Veterinary Studies',
    slug: 'animal-health-veterinary',
    description: 'Animal health, veterinary studies and livestock management',
    sort_order: 36
  },
  {
    name: 'Fisheries & Aquaculture',
    slug: 'fisheries-aquaculture',
    description: 'Fisheries science, fish farming and aquaculture',
    sort_order: 37
  },
  {
    name: 'Forestry & Wildlife Management',
    slug: 'forestry-wildlife-management',
    description: 'Forestry, wildlife conservation and natural resource management',
    sort_order: 38
  },
  {
    name: 'Water Engineering & Sanitation',
    slug: 'water-engineering-sanitation',
    description: 'Water supply, water engineering and sanitation technology',
    sort_order: 39
  },
  {
    name: 'Irrigation & Agricultural Engineering',
    slug: 'irrigation-agricultural-engineering',
    description: 'Agricultural machinery, irrigation and farm engineering',
    sort_order: 40
  },

  // APPLIED AND NATURAL SCIENCES
  {
    name: 'Applied Sciences & Laboratory Technology',
    slug: 'applied-sciences-laboratory',
    description: 'Applied biology, laboratory science and analytical chemistry',
    sort_order: 41
  },
  {
    name: 'Biotechnology & Applied Biology',
    slug: 'biotechnology-applied-biology',
    description: 'Biotechnology, applied biology and related sciences',
    sort_order: 42
  },
  {
    name: 'Environmental Science & Geosciences',
    slug: 'environmental-science-geosciences',
    description: 'Environmental science, geophysics and earth sciences',
    sort_order: 43
  },
  {
    name: 'Surveying, Cartography & GIS',
    slug: 'surveying-cartography-gis',
    description: 'Land surveying, mapping, photogrammetry and geospatial studies',
    sort_order: 44
  },

  // BUSINESS, ADMINISTRATION AND LOGISTICS
  {
    name: 'Procurement & Supply Chain Management',
    slug: 'procurement-supply-chain',
    description: 'Procurement, purchasing, supplies and supply chain management',
    sort_order: 45
  },
  {
    name: 'Transport, Maritime & Logistics',
    slug: 'transport-maritime-logistics',
    description: 'Transport management, maritime operations and logistics',
    sort_order: 46
  },
  {
    name: 'Human Resource & Personnel Management',
    slug: 'human-resource-personnel-management',
    description: 'Human resource management, personnel and employment studies',
    sort_order: 47
  },
  {
    name: 'Office Administration & Secretarial Studies',
    slug: 'office-administration-secretarial',
    description: 'Office administration, clerical operations and secretarial studies',
    sort_order: 48
  },
  {
    name: 'Banking, Finance & Investment',
    slug: 'banking-finance-investment',
    description: 'Banking, investment management and financial services',
    sort_order: 49
  },
  {
    name: 'Entrepreneurship & Cooperative Management',
    slug: 'entrepreneurship-cooperative-management',
    description: 'Entrepreneurship, cooperative management and business development',
    sort_order: 50
  },
  {
    name: 'Marketing, Sales & Customer Service',
    slug: 'marketing-sales-customer-service',
    description: 'Marketing, salesmanship and customer service',
    sort_order: 51
  },

  // SOCIAL AND INFORMATION STUDIES
  {
    name: 'Social Work & Community Development',
    slug: 'social-work-community-development',
    description: 'Social work, community development and social services',
    sort_order: 52
  },
  {
    name: 'Childcare & Early Childhood Development',
    slug: 'childcare-early-childhood-development',
    description: 'Child care, child protection and early childhood development',
    sort_order: 53
  },
  {
    name: 'Library, Archives & Information Studies',
    slug: 'library-archives-information-studies',
    description: 'Library science, records management and archives',
    sort_order: 54
  },
  {
    name: 'Maritime Operations & Nautical Science',
    slug: 'maritime-operations-nautical-science',
    description: 'Nautical science, seafarer training and maritime operations',
    sort_order: 55
  }
];

// ======================================================
// SAMPLE PRODUCTS
// Prices and costs are in Kenyan Shillings (KES).
// These are demonstration products and stock quantities.
// ======================================================

const PRODUCTS = [
  // TEXTBOOKS
  {
    sku: 'TB-MATH-F1',
    name: 'Secondary Mathematics Form 1',
    category: 'textbooks',
    price: 850,
    cost: 550,
    stock: 40,
    desc: 'Form 1 mathematics course textbook.'
  },
  {
    sku: 'TB-ENG-F2',
    name: 'English Form 2 Student Book',
    category: 'textbooks',
    price: 780,
    cost: 500,
    stock: 35,
    desc: 'English language and literature student textbook.'
  },
  {
    sku: 'TB-BIO-F3',
    name: 'Secondary Biology Form 3',
    category: 'textbooks',
    price: 950,
    cost: 620,
    stock: 25,
    desc: 'Biology textbook for secondary school learners.'
  },
  {
    sku: 'TB-CHEM-F4',
    name: 'Secondary Chemistry Form 4',
    category: 'textbooks',
    price: 1100,
    cost: 720,
    stock: 20,
    desc: 'Chemistry textbook for Form 4 students.'
  },

  // STORYBOOKS
  {
    sku: 'ST-RIVER',
    name: 'The River and the Source',
    category: 'storybooks-fiction',
    price: 650,
    cost: 400,
    stock: 50,
    desc: 'Classic Kenyan literary novel.'
  },
  {
    sku: 'ST-BLOSSOMS',
    name: 'Blossoms of the Savannah',
    category: 'storybooks-fiction',
    price: 750,
    cost: 480,
    stock: 35,
    desc: 'African literature and set book reading.'
  },
  {
    sku: 'ST-PEARL',
    name: 'The Pearl',
    category: 'storybooks-fiction',
    price: 550,
    cost: 350,
    stock: 30,
    desc: 'Literary fiction reading book.'
  },

  // STATIONERY
  {
    sku: 'STN-EXB-A4',
    name: 'A4 Exercise Book 200 Pages',
    category: 'stationery',
    price: 120,
    cost: 70,
    stock: 200,
    desc: 'Ruled A4 exercise book.'
  },
  {
    sku: 'STN-PEN-BLUE',
    name: 'Blue Ballpoint Pens Pack of 10',
    category: 'stationery',
    price: 150,
    cost: 80,
    stock: 150,
    desc: 'Blue ballpoint pens for school and office.'
  },
  {
    sku: 'STN-RULER',
    name: '30cm Plastic Ruler',
    category: 'stationery',
    price: 50,
    cost: 25,
    stock: 100,
    desc: 'Transparent 30cm school ruler.'
  },
  {
    sku: 'STN-FILE',
    name: 'Office Document File',
    category: 'stationery',
    price: 100,
    cost: 55,
    stock: 80,
    desc: 'Document storage file.'
  },

  // REVISION GUIDES
  {
    sku: 'REV-KCSE-MATH',
    name: 'KCSE Mathematics Revision Guide',
    category: 'revision-exam-guides',
    price: 1100,
    cost: 700,
    stock: 25,
    desc: 'Mathematics revision and practice questions.'
  },
  {
    sku: 'REV-KCSE-ENG',
    name: 'KCSE English Revision Guide',
    category: 'revision-exam-guides',
    price: 950,
    cost: 600,
    stock: 25,
    desc: 'English revision and examination preparation.'
  },
  {
    sku: 'REV-KCSE-BIO',
    name: 'KCSE Biology Revision Guide',
    category: 'revision-exam-guides',
    price: 1000,
    cost: 650,
    stock: 20,
    desc: 'Biology revision questions and study notes.'
  },

  // CHILDREN AND EARLY LEARNING
  {
    sku: 'CH-ABC',
    name: 'My First ABC Book',
    category: 'children-early-learning',
    price: 280,
    cost: 150,
    stock: 80,
    desc: 'Alphabet learning and picture book.'
  },
  {
    sku: 'CH-NUMBERS',
    name: 'My First Numbers Book',
    category: 'children-early-learning',
    price: 300,
    cost: 160,
    stock: 70,
    desc: 'Basic counting and numbers for young learners.'
  },
  {
    sku: 'CH-COLOUR',
    name: 'Children Colouring Book',
    category: 'children-early-learning',
    price: 250,
    cost: 130,
    stock: 60,
    desc: 'Creative colouring activity book.'
  },

  // RELIGIOUS AND SPIRITUAL
  {
    sku: 'REL-BIBLE',
    name: 'Holy Bible NIV',
    category: 'religious-spiritual',
    price: 1200,
    cost: 800,
    stock: 40,
    desc: 'Holy Bible in New International Version.'
  },
  {
    sku: 'REL-DEVOTION',
    name: 'Daily Devotional Book',
    category: 'religious-spiritual',
    price: 650,
    cost: 400,
    stock: 25,
    desc: 'Daily inspirational and devotional reading.'
  },

  // GENERAL INTEREST
  {
    sku: 'GEN-BIOGRAPHY',
    name: 'African Leaders and Biographies',
    category: 'general-interest',
    price: 850,
    cost: 550,
    stock: 15,
    desc: 'Biographical reading about African leaders.'
  },
  {
    sku: 'GEN-MOTIVATION',
    name: 'Personal Development and Success',
    category: 'general-interest',
    price: 700,
    cost: 420,
    stock: 20,
    desc: 'Personal growth and motivational reading.'
  },

  // TVET
  {
    sku: 'TVET-ELEC-1',
    name: 'Electrical Installation Level 5 Module',
    category: 'tvet-course-materials',
    price: 980,
    cost: 620,
    stock: 30,
    desc: 'Electrical installation training material.'
  },
  {
    sku: 'TVET-PLUMB',
    name: 'Plumbing Technology Training Guide',
    category: 'tvet-course-materials',
    price: 1200,
    cost: 800,
    stock: 15,
    desc: 'Plumbing and pipe installation training guide.'
  },

  // ENGINEERING
  {
    sku: 'ENG-MECH',
    name: 'Introduction to Mechanical Engineering',
    category: 'engineering-technical',
    price: 1850,
    cost: 1200,
    stock: 12,
    desc: 'Fundamentals of mechanical engineering.'
  },
  {
    sku: 'ENG-ELEC',
    name: 'Basic Electrical Engineering',
    category: 'engineering-technical',
    price: 1600,
    cost: 1050,
    stock: 15,
    desc: 'Electrical engineering principles and applications.'
  },

  // ICT AND COMPUTING
  {
    sku: 'ICT-PYTHON',
    name: 'Introduction to Python Programming',
    category: 'ict-computing',
    price: 1450,
    cost: 900,
    stock: 25,
    desc: 'Introduction to Python programming.'
  },
  {
    sku: 'ICT-COMPUTER',
    name: 'Computer Applications and Office Skills',
    category: 'ict-computing',
    price: 1100,
    cost: 700,
    stock: 20,
    desc: 'Computer applications and office productivity.'
  },
  {
    sku: 'ICT-WEB',
    name: 'Web Development Fundamentals',
    category: 'ict-computing',
    price: 1700,
    cost: 1100,
    stock: 12,
    desc: 'HTML, CSS and JavaScript fundamentals.'
  },

  // BUSINESS AND ACCOUNTING
  {
    sku: 'BUS-ACC-1',
    name: 'Financial Accounting for Colleges',
    category: 'business-accounting',
    price: 1320,
    cost: 850,
    stock: 28,
    desc: 'Accounting principles and financial reporting.'
  },
  {
    sku: 'BUS-MGMT',
    name: 'Principles of Business Management',
    category: 'business-accounting',
    price: 1250,
    cost: 800,
    stock: 18,
    desc: 'Business management and administration.'
  },
  {
    sku: 'BUS-ECON',
    name: 'Introduction to Economics',
    category: 'business-accounting',
    price: 1150,
    cost: 750,
    stock: 20,
    desc: 'Basic economic principles and concepts.'
  },

  // HEALTH SCIENCES
  {
    sku: 'HEA-NUR-1',
    name: 'Fundamentals of Nursing Practice',
    category: 'health-sciences',
    price: 2100,
    cost: 1400,
    stock: 15,
    desc: 'Fundamentals of nursing practice.'
  },
  {
    sku: 'HEA-ANATOMY',
    name: 'Human Anatomy and Physiology',
    category: 'health-sciences',
    price: 2400,
    cost: 1600,
    stock: 10,
    desc: 'Introductory anatomy and physiology textbook.'
  },

  // AGRICULTURE
  {
    sku: 'AGR-CROP',
    name: 'Principles of Crop Production',
    category: 'agriculture-environment',
    price: 1350,
    cost: 850,
    stock: 18,
    desc: 'Crop production and farm management.'
  },
  {
    sku: 'AGR-LIVESTOCK',
    name: 'Livestock Production Guide',
    category: 'agriculture-environment',
    price: 1250,
    cost: 800,
    stock: 15,
    desc: 'Livestock management and animal production.'
  },

  // HOSPITALITY
  {
    sku: 'HOS-FOOD',
    name: 'Food Production and Preparation',
    category: 'hospitality-tourism',
    price: 1450,
    cost: 950,
    stock: 12,
    desc: 'Food preparation and production training.'
  },
  {
    sku: 'HOS-TOURISM',
    name: 'Introduction to Tourism Management',
    category: 'hospitality-tourism',
    price: 1550,
    cost: 1000,
    stock: 12,
    desc: 'Tourism management and hospitality studies.'
  },

  // EDUCATION
  {
    sku: 'EDU-PSYCH',
    name: 'Educational Psychology',
    category: 'education-teaching',
    price: 1650,
    cost: 1050,
    stock: 15,
    desc: 'Psychology and learning in education.'
  },
  {
    sku: 'EDU-METHODS',
    name: 'Teaching Methods and Practice',
    category: 'education-teaching',
    price: 1400,
    cost: 900,
    stock: 18,
    desc: 'Teaching methods and classroom practice.'
  },

  // UNIVERSITY
  {
    sku: 'UNI-CALC',
    name: 'University Calculus Volume 1',
    category: 'university-textbooks',
    price: 2850,
    cost: 1900,
    stock: 12,
    desc: 'University-level calculus textbook.'
  },
  {
    sku: 'UNI-STAT',
    name: 'Introduction to Statistics',
    category: 'university-textbooks',
    price: 2300,
    cost: 1500,
    stock: 10,
    desc: 'Statistics textbook for university students.'
  },

  // LAW AND SOCIAL SCIENCES
  {
    sku: 'LAW-INTRO',
    name: 'Introduction to Kenyan Law',
    category: 'law-social-sciences',
    price: 1750,
    cost: 1100,
    stock: 14,
    desc: 'Introductory Kenyan law textbook.'
  },
  {
    sku: 'SOC-SOCIOLOGY',
    name: 'Introduction to Sociology',
    category: 'law-social-sciences',
    price: 1500,
    cost: 950,
    stock: 15,
    desc: 'Introduction to social institutions and society.'
  }
];

// ======================================================
// DEFAULT DELIVERY ZONES
// ======================================================

const DEFAULT_DELIVERY_ZONES = [
  {
    name: 'Mawego & nearby',
    fee_kes: 200,
    min_order_kes: 0,
    is_active: true
  },
  {
    name: 'Homa Bay town',
    fee_kes: 350,
    min_order_kes: 0,
    is_active: true
  },
  {
    name: 'Other locations',
    fee_kes: 500,
    min_order_kes: 0,
    is_active: true
  }
];

// ======================================================
// DEFAULT SHOP SETTINGS
// ======================================================

const DEFAULT_SETTINGS = {
  shop_name: 'Mawego Bookshop',
  currency: 'KES',
  default_delivery_fee: '200',
  free_delivery_threshold: '2000',
  shop_phone: '+254757751980',
  shop_address: 'Mawego, Kenya',
  shop_email: 'info@mawegobookshop',
  receipt_footer: 'Thank you for shopping at Mawego Bookshop'
};

// ======================================================
// SEED CATEGORIES
// ======================================================

async function seedCategories() {
  let added = 0;

  for (const category of ALL_CATEGORIES) {
    const result = await Category.updateOne(
      { slug: category.slug },
      {
        $setOnInsert: {
          ...category,
          is_active: true
        }
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      added++;
    }
  }

  console.log(`Categories added: ${added}`);
  console.log('Categories ready.');
}

// ======================================================
// SEED OWNER ACCOUNT
// ======================================================

async function seedOwner() {
  const configuredEmail = process.env.ADMIN_EMAIL
    ? process.env.ADMIN_EMAIL.trim().toLowerCase()
    : null;

  let owner = configuredEmail
    ? await User.findOne({ email: configuredEmail })
    : await User.findOne({ role: 'owner' });

  if (owner) {
    console.log(`Owner already exists: ${owner.email}`);
    return;
  }

  const email = configuredEmail || 'jbrolex42@gmail.com';
  const password = process.env.ADMIN_PASSWORD;

  if (!password || password.length < 12) {
    throw new Error(
      'Set ADMIN_PASSWORD in your .env file (at least 12 characters) before creating the owner account.'
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  owner = await User.create({
    email,
    password_hash: passwordHash,
    full_name: process.env.ADMIN_NAME || 'Shop Owner',
    role: 'owner',
    permissions: ['*'],
    is_active: true
  });

  console.log(`Owner account created: ${owner.email}`);
}

// ======================================================
// SEED DELIVERY ZONES
// ======================================================

async function seedDeliveryZones() {
  let added = 0;

  for (const zone of DEFAULT_DELIVERY_ZONES) {
    const existing = await DeliveryZone.findOne({
      name: zone.name
    });

    if (existing) {
      continue;
    }

    await DeliveryZone.create(zone);
    added++;
  }

  console.log(`Delivery zones added: ${added}`);
}

// ======================================================
// SEED SHOP SETTINGS
// ======================================================

async function seedSettings() {
  let added = 0;

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const result = await Setting.updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          value,
          updated_at: new Date()
        }
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) {
      added++;
    }
  }

  console.log(`Shop settings added: ${added}`);
}

// ======================================================
// BUILD CATEGORY LOOKUP
// ======================================================

async function getCategoryMap() {
  const categories = await Category.find({
    slug: {
      $in: ALL_CATEGORIES.map(category => category.slug)
    }
  });

  const categoryMap = {};

  for (const category of categories) {
    categoryMap[category.slug] = category._id;
  }

  return categoryMap;
}

// ======================================================
// SEED PRODUCTS AND INITIAL STOCK
// ======================================================

async function seedProducts() {
  const categoryMap = await getCategoryMap();

  let added = 0;
  let skipped = 0;
  let ledgerEntries = 0;

  for (const item of PRODUCTS) {
    const categoryId = categoryMap[item.category];

    if (!categoryId) {
      throw new Error(
        `Category not found for product ${item.sku}: ${item.category}`
      );
    }

    let product = await Product.findOne({
      sku: item.sku
    });

    let isNewProduct = false;

    if (!product) {
      product = await Product.create({
        sku: item.sku,
        barcode: item.sku,
        name: item.name,
        slug: slugify(item.name),
        description: item.desc,
        category_id: categoryId,
        price_kes: item.price,
        cost_kes: item.cost,
        stock_qty: item.stock,
        low_stock_threshold: 5,
        is_active: true
      });

      added++;
      isNewProduct = true;

      console.log(`Added product: ${item.name}`);
    } else {
      skipped++;
    }

    // Only create initial stock ledger entries for new products.
    // Existing inventory is never reset by this script.
    if (isNewProduct) {
      await StockLedger.create({
        product_id: product._id,
        change_qty: item.stock,
        balance_after: item.stock,
        reason: 'initial_stock',
        reference_type: 'seed',
        notes: 'Initial stock created by Mawego Bookshop seed script.'
      });

      ledgerEntries++;
    }
  }

  console.log('');
  console.log('Product seeding results:');
  console.log(`New products: ${added}`);
  console.log(`Existing products skipped: ${skipped}`);
  console.log(`Initial stock entries created: ${ledgerEntries}`);
}

// ======================================================
// MAIN SEED FUNCTION
// ======================================================

async function seed() {
  console.log('');
  console.log('======================================');
  console.log('     MAWEGO BOOKSHOP DATABASE SEED');
  console.log('======================================');
  console.log('');

  await connectMongo();

  console.log('MongoDB connected.');

  await seedCategories();
  await seedOwner();
  await seedDeliveryZones();
  await seedSettings();
  await seedProducts();

  console.log('');
  console.log('======================================');
  console.log('       SEED COMPLETED SUCCESSFULLY');
  console.log('======================================');
  console.log(`Categories configured: ${ALL_CATEGORIES.length}`);
  console.log(`Products in seed catalogue: ${PRODUCTS.length}`);
  console.log('');
}

// ======================================================
// RUN SEED
// ======================================================

async function main() {
  try {
    await seed();
  } catch (error) {
    console.error('');
    console.error('DATABASE SEED FAILED:');
    console.error(error.stack || error.message);

    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close().catch(error => {
        console.error('MongoDB close error:', error.message);
      });
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  seed,
  ALL_CATEGORIES,
  PRODUCTS
};