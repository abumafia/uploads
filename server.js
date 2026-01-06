require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');

const app = express();
const PORT = process.env.PORT || 3001;

// Cloudinary konfiguratsiyasi
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// MongoDB ulanish
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB ulandi'))
  .catch(err => console.error('MongoDB xatosi:', err));

// Media modeli
const MediaSchema = new mongoose.Schema({
  publicId: { type: String, required: true },
  originalName: { type: String, required: true },
  secureUrl: { type: String, required: true },
  resourceType: { type: String, required: true }, // image yoki video
  format: String,
  size: Number,
  uploadDate: { type: Date, default: Date.now }
});

const Media = mongoose.model('Media', MediaSchema);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer – faylni memoryda saqlaymiz (diskka yozmaymiz)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Faqat rasm va video fayllari!'), false);
    }
  }
});

// Sahifalar
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Upload API
app.post('/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Fayl tanlanmadi' });

    const resourceType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';

    const uploadOptions = {
      resource_type: resourceType,
      folder: 'uploadsx',
      use_filename: true,
      unique_filename: false,
      overwrite: true,
      quality: resourceType === 'image' ? 'auto:good' : 'auto',
      fetch_format: resourceType === 'image' ? 'auto' : undefined,
    };

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const newMedia = new Media({
      publicId: result.public_id,
      originalName: req.file.originalname,
      secureUrl: result.secure_url,
      resourceType: result.resource_type,
      format: result.format,
      size: result.bytes,
    });

    await newMedia.save();
    // Proxy havola qaytariladi
    const proxyUrl = `/cdn/${result.public_id}`;

    res.json({
      success: true,
      message: 'Muvaffaqiyatli yuklandi!',
      url: result.secure_url,
      type: result.resource_type
    });

  } catch (error) {
    console.error('Upload xatosi:', error);
    res.status(500).json({ error: 'Yuklashda xatolik yuz berdi' });
  }
});

// Barcha media ro'yxati
app.get('/api/media', async (req, res) => {
  try {
    const media = await Media.find().sort({ uploadDate: -1 }).limit(50);
    res.json(media);
  } catch (err) {
    res.status(500).json({ error: 'Xatolik' });
  }
});

// Media o'chirish
app.delete('/api/media/:id', async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    if (!media) return res.status(404).json({ error: 'Topilmadi' });

    await cloudinary.uploader.destroy(media.publicId, {
      resource_type: media.resourceType
    });

    await Media.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'O\'chirildi' });
  } catch (err) {
    res.status(500).json({ error: 'O\'chirishda xatolik' });
  }
});

// Statistika
app.get('/api/stats', async (req, res) => {
  try {
    const totalMedia = await Media.countDocuments();
    const totalImages = await Media.countDocuments({ resourceType: 'image' });
    const totalVideos = await Media.countDocuments({ resourceType: 'video' });
    const agg = await Media.aggregate([{ $group: { _id: null, total: { $sum: '$size' } } }]);
    const totalSize = agg.length > 0 ? agg[0].total : 0;

    res.json({
      totalMedia,
      totalImages,
      totalVideos,
      totalSize
    });
  } catch (err) {
    res.status(500).json({ error: 'Xatolik' });
  }
});

// ... oldingi kodlar (Cloudinary config, upload va h.k.)

// CDN Proxy Route – YANGI QISM
app.get('/cdn/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    const format = req.query.f || req.query.fl || ''; // ixtiyoriy format
    const quality = req.query.q || 'auto'; // sifat

    // Cloudinary URL ni qo‘lda yaratamiz (optimallashtirilgan)
    let cloudinaryUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/image/upload/`;

    // Agar video bo‘lsa
    if (publicId.includes('video/')) {
      cloudinaryUrl = cloudinaryUrl.replace('/image/upload/', '/video/upload/');
    }

    cloudinaryUrl += `q_${quality},f_auto/${publicId}`;

    if (format) {
      cloudinaryUrl += `.${format}`;
    }

    // Cloudinary'dan faylni olish va proxy qilish
    const response = await fetch(cloudinaryUrl);
    if (!response.ok) throw new Error('Cloudinary xatosi');

    // Header'larni o'tkazish (cache, content-type)
    res.set('Content-Type', response.headers.get('content-type'));
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // 1 yil cache
    res.set('Access-Control-Allow-Origin', '*');

    // Stream orqali yuborish (tezkor va xotirani tejaydi)
    response.body.pipe(res);
  } catch (error) {
    console.error('Proxy xatosi:', error);
    res.status(404).send('Fayl topilmadi');
  }
});

app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishga tushdi: https://uploadsx.onrender.com`);
});
