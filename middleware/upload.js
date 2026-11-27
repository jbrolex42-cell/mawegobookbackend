
'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_FILE_SIZE = 5 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
]);

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif'
]);

const DEFAULT_CLOUDINARY_FOLDER = 'mawego-bookshop/products';

let cloudinaryInstance = null;
let cloudinaryConfiguredAtLoad = null;

function ensureUploadDirectory() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

ensureUploadDirectory();

function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
}

function getCloudinary() {
  if (!cloudinaryConfigured()) {
    return null;
  }

  if (!cloudinaryInstance) {
    const cloudinary = require('cloudinary').v2;

    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });

    cloudinaryInstance = cloudinary;
    cloudinaryConfiguredAtLoad = true;
  }

  return cloudinaryInstance;
}

function imageFileFilter(_req, file, callback) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const mimeType = String(file.mimetype || '').toLowerCase();

  const validExtension = ALLOWED_EXTENSIONS.has(extension);
  const validMimeType = ALLOWED_MIME_TYPES.has(mimeType);

  if (validExtension && validMimeType) {
    return callback(null, true);
  }

  return callback(
    new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname)
  );
}

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 20,
    parts: 25
  },
  fileFilter: imageFileFilter
});

const diskUpload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      callback(null, UPLOAD_DIR);
    },

    filename(_req, file, callback) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const uniqueName = [
        Date.now(),
        process.pid,
        require('crypto').randomBytes(8).toString('hex')
      ].join('-');

      callback(null, `${uniqueName}${extension}`);
    }
  }),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
    fields: 20,
    parts: 25
  },

  fileFilter: imageFileFilter
});

function productImage() {
  return cloudinaryConfigured()
    ? memoryUpload.single('image')
    : diskUpload.single('image');
}

function uploadToCloudinary(buffer, options = {}) {
  const cloudinary = getCloudinary();

  if (!cloudinary) {
    throw new Error('Cloudinary is not configured');
  }

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || DEFAULT_CLOUDINARY_FOLDER,
        resource_type: 'image',
        transformation: [
          {
            width: 1200,
            height: 1200,
            crop: 'limit',
            quality: 'auto',
            fetch_format: 'auto'
          }
        ]
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }

        if (!result || !result.secure_url || !result.public_id) {
          return reject(new Error('Cloudinary returned an invalid upload result'));
        }

        resolve(result);
      }
    );

    Readable.from(buffer).pipe(uploadStream);
  });
}

async function removeLocalUpload(filename) {
  if (!filename) return;

  const safeFilename = path.basename(filename);
  const filePath = path.resolve(UPLOAD_DIR, safeFilename);
  const uploadRoot = path.resolve(UPLOAD_DIR);

  if (!filePath.startsWith(`${uploadRoot}${path.sep}`)) {
    throw new Error('Invalid upload file path');
  }

  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function resolveImageUrl(req, res, next) {
  if (!req.file) {
    return next();
  }

  try {
    if (req.file.buffer) {
      const folder =
        req.uploadFolder ||
        process.env.CLOUDINARY_FOLDER ||
        DEFAULT_CLOUDINARY_FOLDER;

      const result = await uploadToCloudinary(req.file.buffer, {
        folder
      });

      req.imageUrl = result.secure_url;
      req.cloudinaryPublicId = result.public_id;
      req.imageStorage = 'cloudinary';
    } else if (req.file.filename) {
      req.imageUrl = `/uploads/${encodeURIComponent(req.file.filename)}`;
      req.imageStorage = 'local';
    } else {
      throw new Error('Uploaded file has no accessible storage data');
    }

    return next();
  } catch (error) {
    console.error('Image upload failed:', error);

    if (req.file.filename) {
      try {
        await removeLocalUpload(req.file.filename);
      } catch (cleanupError) {
        console.error('Failed to clean up uploaded file:', cleanupError);
      }
    }

    return res.status(500).json({
      error: 'Image upload failed',
      message:
        process.env.NODE_ENV === 'production'
          ? 'The image could not be uploaded. Please try again.'
          : error.message
    });
  }
}

function handleUploadError(error, _req, res, next) {
  if (!error) {
    return next();
  }

  if (error instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: 'Image exceeds the 5 MB file size limit',
      LIMIT_FILE_COUNT: 'Only one image can be uploaded at a time',
      LIMIT_UNEXPECTED_FILE: 'Only JPG, PNG, WebP, and GIF images are allowed'
    };

    return res.status(400).json({
      error: messages[error.code] || 'Invalid image upload'
    });
  }

  return next(error);
}

module.exports = {
  productImage,
  resolveImageUrl,
  cloudinaryConfigured,
  getCloudinary,
  uploadToCloudinary,
  removeLocalUpload,
  handleUploadError,
  UPLOAD_DIR,
  MAX_FILE_SIZE
};