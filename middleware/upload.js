const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

function cloudinaryConfigured() {
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

let cloudinary = null;
function getCloudinary() {
  if (!cloudinary && cloudinaryConfigured()) {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });
  }
  return cloudinary;
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /jpeg|jpg|png|webp|gif/i.test(path.extname(file.originalname)) ||
      /image\/(jpeg|jpg|png|webp|gif)/i.test(file.mimetype);
    cb(ok ? null : new Error('Only image files allowed (jpg, png, webp, gif)'), ok);
  }
});

const diskUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
      cb(null, unique + path.extname(file.originalname).toLowerCase());
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /jpeg|jpg|png|webp|gif/i.test(path.extname(file.originalname));
    cb(ok ? null : new Error('Only image files allowed'), ok);
  }
});

function productImage() {
  if (cloudinaryConfigured()) return memoryUpload.single('image');
  return diskUpload.single('image');
}

async function resolveImageUrl(req, res, next) {
  try {
    if (!req.file) return next();

    if (cloudinaryConfigured() && req.file.buffer) {
      const cld = getCloudinary();
      const folder =
       req.uploadFolder ||
   process.env.CLOUDINARY_FOLDER ||
  'mawego-bookshop/products';   
      const result = await new Promise((resolve, reject) => {
        const stream = cld.uploader.upload_stream(
          {
            folder,
            resource_type: 'image',
            transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }]
          },
          (err, uploaded) => (err ? reject(err) : resolve(uploaded))
        );
        Readable.from(req.file.buffer).pipe(stream);
      });
      req.imageUrl = result.secure_url;
      req.cloudinaryPublicId = result.public_id;
    } else if (req.file.filename) {
      req.imageUrl = `/uploads/${req.file.filename}`;
    }
    next();
  } catch (err) {
    console.error('Image upload failed:', err.message);
    res.status(500).json({ error: 'Image upload failed: ' + (err.message || 'unknown error') });
  }
}

module.exports = {
  productImage,
  resolveImageUrl,
  cloudinaryConfigured,
  getCloudinary
};
