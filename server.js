require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const { v2: cloudinary } = require('cloudinary');
const fetch = require('node-fetch'); // npm install node-fetch@2

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
  .then(() => console.log('MongoDB muvaffaqiyatli ulandi'))
  .catch(err => console.error('MongoDB ulanish xatosi:', err));

// Media modeli
const MediaSchema = new mongoose.Schema({
  publicId: { type: String, required: true },
  originalName: { type: String, required: true },
  secureUrl: { type: String, required: true },
  resourceType: { type: String, required: true }, // 'image' yoki 'video'
  format: String,
  size: Number,
  uploadDate: { type: Date, default: Date.now }
});

const Media = mongoose.model('Media', MediaSchema);

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer – memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Faqat rasm va video fayllariga ruxsat berilgan!'), false);
    }
  }
});

// Sahifalar
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// === YANGI: CDN Proxy Route ===
app.get('/cdn/:publicId', async (req, res) => {
  try {
    const { publicId } = req.params;
    const { w, q = 'auto', f } = req.query; // ?w=400&q=60&f=webp

    // publicId orqali resource_type aniqlash (DB dan olish yaxshiroq, lekin tezlik uchun folderdan taxmin qilamiz)
    const isVideo = publicId.startsWith('uploadsx/') && await Media.findOne({ publicId }).then(m => m?.resourceType === 'video');

    let baseUrl = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}`;
    baseUrl += isVideo ? '/video/upload/' : '/image/upload/';

    // Transformations
    const transformations = [];
    if (w) transformations.push(`w_${w}`);
    transformations.push(`q_${q}`);
    transformations.push(`f_${f || 'auto'}`);

    const fullUrl = `${baseUrl}${transformations.join(',')}/${publicId}`;

    const response = await fetch(fullUrl);
    if (!response.ok) throw new Error(`Cloudinary xatosi: ${response.status}`);

    // Headerlar
    const contentType = response.headers.get('content-type') || (isVideo ? 'video/mp4' : 'image/jpeg');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // 1 yil cache
    res.set('Access-Control-Allow-Origin', '*');

    response.body.pipe(res);
  } catch (error) {
    console.error('CDN Proxy xatosi:', error);
    res.status(404).send('Fayl topilmadi yoki xatolik yuz berdi');
  }
});

// Upload API – Proxy havola qaytaradi
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
      quality: 'auto',
      fetch_format: 'auto'
    };

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
        if (error) return reject(error);
        resolve(result);
      });
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

    // Foydalanuvchiga faqat o'z domeningiz orqali havola qaytaramiz
    const proxyUrl = `/cdn/${result.public_id}`;

    res.json({
      success: true,
      message: 'Muvaffaqiyatli yuklandi!',
      url: proxyUrl,           // <--- Muhim: proxy orqali
      type: result.resource_type
    });

  } catch (error) {
    console.error('Upload xatosi:', error);
    res.status(500).json({ error: 'Server xatosi yuz berdi' });
  }
});

// Barcha media ro'yxati
app.get('/api/media', async (req, res) => {
  try {
    const media = await Media.find().sort({ uploadDate: -1 }).limit(100);
    res.json(media);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Media ro\'yxatini olishda xatolik' });
  }
});

// Media o'chirish
app.delete('/api/media/:id', async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    if (!media) return res.status(404).json({ error: 'Media topilmadi' });

    await cloudinary.uploader.destroy(media.publicId, {
      resource_type: media.resourceType
    });

    await Media.findByIdAndDelete(req.params.id);

    res.json({ success: true, message: 'Media muvaffaqiyatli o\'chirildi' });
  } catch (err) {
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: 'Statistika olishda xatolik' });
  }
});

// Serverni ishga tushirish
app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);
  console.log(`Sayt: https://uploadsx.onrender.com`);
  console.log(`CDN Proxy: https://uploadsx.onrender.com/cdn/uploadsx/fayl_nomi`);
});
