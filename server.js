const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// MongoDB ulanish
mongoose.connect('mongodb+srv://apl:apl00@gamepaymentbot.ffcsj5v.mongodb.net/img?retryWrites=true&w=majority', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Media modeli
const Media = require('./models/Media');

// Middleware sozlamalari
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Upload qilish uchun papka yaratish
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer sozlamalari (fayl nomini o'zgartirmaslik)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/')
  },
  filename: function (req, file, cb) {
    // Fayl nomi va kengaytmasini saqlab qolish
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  fileFilter: function (req, file, cb) {
    // Rasm va video fayllarini qabul qilish
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Faqat rasm va video fayllari ruxsat etilgan!'), false);
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Asosiy sahifa
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Admin sahifasi
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Media yuklash API
app.post('/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Media fayli topilmadi' });
    }

    // Yangi media yaratish
    const newMedia = new Media({
      filename: req.file.filename,
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      type: req.file.mimetype.startsWith('image/') ? 'image' : 'video',
      uploadDate: new Date()
    });

    // Ma'lumotlar bazasiga saqlash
    await newMedia.save();

    // URL ni qaytarish
    const mediaUrl = `${req.protocol}://${req.get('host')}/media/${req.file.filename}`;
    res.json({ 
      success: true, 
      message: 'Media muvaffaqiyatli yuklandi!',
      url: mediaUrl,
      type: newMedia.type
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server xatosi yuz berdi' });
  }
});

// Mediani ko'rsatish
app.get('/media/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const media = await Media.findOne({ filename });
    
    if (!media) {
      return res.status(404).send('Media topilmadi');
    }
    
    res.sendFile(path.join(__dirname, 'uploads', filename));
  } catch (error) {
    console.error(error);
    res.status(500).send('Server xatosi');
  }
});

// Barcha media ro'yxati (admin uchun)
app.get('/api/media', async (req, res) => {
  try {
    const media = await Media.find().sort({ uploadDate: -1 });
    res.json(media);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// Mediani o'chirish
app.delete('/api/media/:id', async (req, res) => {
  try {
    const media = await Media.findById(req.params.id);
    
    if (!media) {
      return res.status(404).json({ error: 'Media topilmadi' });
    }
    
    // Faylni filesystemdan o'chirish
    fs.unlinkSync(path.join(__dirname, 'uploads', media.filename));
    
    // Ma'lumotlar bazasidan o'chirish
    await Media.findByIdAndDelete(req.params.id);
    
    res.json({ success: true, message: 'Media muvaffaqiyatli o\'chirildi' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// Statistikalar
app.get('/api/stats', async (req, res) => {
  try {
    const totalMedia = await Media.countDocuments();
    const totalImages = await Media.countDocuments({ type: 'image' });
    const totalVideos = await Media.countDocuments({ type: 'video' });
    const totalSize = await Media.aggregate([
      { $group: { _id: null, total: { $sum: '$size' } } }
    ]);
    
    res.json({
      totalMedia,
      totalImages,
      totalVideos,
      totalSize: totalSize.length > 0 ? totalSize[0].total : 0
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Server xatosi' });
  }
});

// Serverni ishga tushurish
app.listen(PORT, () => {
  console.log(`Server ${PORT}-portda ishga tushdi`);
});