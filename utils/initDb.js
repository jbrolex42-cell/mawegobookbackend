
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const path = require('path');

const ALL_CATEGORIES = [
  // GENERAL BOOKSHOP CATEGORIES
  {
    name: 'Textbooks',
    slug: 'textbooks',
    description: 'Curriculum and academic textbooks for primary and secondary schools',
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
    description: 'Pens, exercise books, files and office supplies',
    sort_order: 3
  },
  {
    name: 'Revision & Exam Guides',
    slug: 'revision-exam-guides',
    description: 'KCPE, KCSE and other examination revision materials',
    sort_order: 4
  },
  {
    name: 'Children & Early Learning',
    slug: 'children-early-learning',
    description: 'Picture books, early readers and learning materials',
    sort_order: 5
  },
  {
    name: 'Religious & Spiritual',
    slug: 'religious-spiritual',
    description: 'Bibles, hymnals and spiritual reading materials',
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
    description: 'TVET modules, workbooks and technical training materials',
    sort_order: 8
  },
  {
    name: 'Engineering & Technical',
    slug: 'engineering-technical',
    description: 'Mechanical, electrical, civil and automotive engineering texts',
    sort_order: 9
  },
  {
    name: 'ICT & Computing',
    slug: 'ict-computing',
    description: 'Computer studies, programming, networking and IT certification guides',
    sort_order: 10
  },
  {
    name: 'Business & Accounting',
    slug: 'business-accounting',
    description: 'Business studies, accounting, entrepreneurship and management',
    sort_order: 11
  },
  {
    name: 'Health Sciences',
    slug: 'health-sciences',
    description: 'Nursing, clinical medicine, pharmacy and public health materials',
    sort_order: 12
  },
  {
    name: 'Agriculture & Environment',
    slug: 'agriculture-environment',
    description: 'Agriculture, agribusiness and environmental studies',
    sort_order: 13
  },
  {
    name: 'Hospitality & Tourism',
    slug: 'hospitality-tourism',
    description: 'Food production, hotel management and tourism studies',
    sort_order: 14
  },
  {
    name: 'Education & Teaching',
    slug: 'education-teaching',
    description: 'Teacher training, pedagogy and education studies',
    sort_order: 15
  },
  {
    name: 'University Textbooks',
    slug: 'university-textbooks',
    description: 'Degree-level core and recommended university textbooks',
    sort_order: 16
  },
  {
    name: 'Law & Social Sciences',
    slug: 'law-social-sciences',
    description: 'Law, sociology, psychology and related social science texts',
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
// DEFAULT DELIVERY ZONES
// ======================================================

const DEFAULT_DELIVERY_ZONES = [
  {
    name: 'Mawego & nearby',
    fee_kes: 200,
    min_order_kes: 0,
    is_active: 1
  },
  {
    name: 'Homa Bay town',
    fee_kes: 350,
    min_order_kes: 0,
    is_active: 1
  },
  {
    name: 'Other locations',
    fee_kes: 500,
    min_order_kes: 0,
    is_active: 1
  }
];

// ======================================================
// DEFAULT SETTINGS
// ======================================================

const DEFAULT_SETTINGS = {
  shop_name: 'Mawego Bookshop',
  default_delivery_fee: '200',
  free_delivery_threshold: '2000',
  shop_phone: '+254757751980',
  shop_address: 'Mawego, Kenya',
  shop_email: 'info@mawegobookshop',
  receipt_footer: 'Thank you for shopping at Mawego Bookshop',
  tax_rate_percent: '0',
  facebook_url: 'https://facebook.com/',
  whatsapp_url: 'https://wa.me/qr/WYE74MOMBBA3J1',
  instagram_url: 'https://www.instagram.com/icedrolex1?knvt=M20xb3ZzbXJkczZk&utm_source=qr',
  twitter_url: 'https://x.com/kenduniccur?s=1',
  youtube_url: 'https://youtube.com/',
  map_url: 'https://maps.app.goo.gl/f3eSQpFqC9bXjWWC6',
  terms_and_conditions: 'All sales are final. Please read our return policy.',
  privacy_policy: 'We respect your privacy and do not share your information.',
  about_us: 'Mawego Bookshop is your trusted source for textbooks, storybooks, and educational materials in Kenya.'
};

// ======================================================
// ENSURE CATEGORIES
// ======================================================

function ensureCategories() {
  const existing = db.all('categories') || [];
  const existingSlugs = new Set(
    existing.map(category => category.slug)
  );

  let added = 0;

  for (const category of ALL_CATEGORIES) {
    if (existingSlugs.has(category.slug)) {
      continue;
    }

    db.insert('categories', {
      ...category,
      is_active: 1,
      created_at: db.now()
    });

    existingSlugs.add(category.slug);
    added++;
  }

  console.log(`Categories added: ${added}`);
  console.log(`Categories configured: ${ALL_CATEGORIES.length}`);

  return added;
}

// ======================================================
// ENSURE DELIVERY ZONES
// ======================================================

function ensureDeliveryZones() {
  const existing = db.all('delivery_zones') || [];
  const existingNames = new Set(
    existing.map(zone => zone.name)
  );

  let added = 0;

  for (const zone of DEFAULT_DELIVERY_ZONES) {
    if (existingNames.has(zone.name)) {
      continue;
    }

    db.insert('delivery_zones', {
      ...zone,
      created_at: db.now()
    });

    existingNames.add(zone.name);
    added++;
  }

  console.log(`Delivery zones added: ${added}`);

  return added;
}

// ======================================================
// ENSURE SHOP SETTINGS
// ======================================================

function ensureSettings() {
  let added = 0;

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = db.get(
      'settings',
      setting => setting.key === key
    );

    if (existing) {
      continue;
    }

    db.insert('settings', {
      key,
      value,
      updated_at: db.now()
    });

    added++;
  }

  console.log(`Shop settings added: ${added}`);

  return added;
}

// ======================================================
// ENSURE OWNER ACCOUNT
// ======================================================

function ensureOwner() {
  const owner = db.get(
    'users',
    user => user.role === 'owner'
  );

  if (owner) {
    console.log(`Owner already exists: ${owner.email}`);
    return false;
  }

  const email = (
    process.env.ADMIN_EMAIL || 'admin@mawego.bookshop'
  ).trim().toLowerCase();

  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Shop Owner';

  if (!password || password.length < 12) {
    throw new Error(
      'Cannot create the owner account. Set ADMIN_PASSWORD in your root .env file to a strong password of at least 12 characters.'
    );
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  db.insert('users', {
    email,
    password_hash: passwordHash,
    full_name: name,
    phone: null,
    role: 'owner',
    permissions: ['*'],
    is_active: 1,
    created_at: db.now(),
    updated_at: db.now()
  });

  console.log(`Default owner created: ${email}`);

  return true;
}

// ======================================================
// MAIN INITIALIZATION
// ======================================================

function init() {
  console.log('');
  console.log('======================================');
  console.log('  MAWEGO BOOKSHOP DATABASE INITIALIZER');
  console.log('======================================');
  console.log('');

  ensureCategories();
  ensureDeliveryZones();
  ensureSettings();
  ensureOwner();

  console.log('');
  console.log('======================================');
  console.log('       DATABASE INITIALIZED');
  console.log('======================================');
  console.log(`Categories configured: ${ALL_CATEGORIES.length}`);
  console.log('');
}

// ======================================================
// RUN DIRECTLY
// ======================================================

if (require.main === module) {
  require('dotenv').config({
    path: path.join(__dirname, '..', '..', '.env')
  });

  try {
    init();
  } catch (error) {
    console.error('');
    console.error('DATABASE INITIALIZATION FAILED:');
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  init,
  ensureCategories,
  ensureDeliveryZones,
  ensureSettings,
  ensureOwner,
  ALL_CATEGORIES
};