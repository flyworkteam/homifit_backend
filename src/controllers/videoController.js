const AppError = require('../utils/appError');
const catalog = require('../services/videoCatalog');

function listAll(req, res, next) {
  try {
    void req;
    const videos = catalog.listAll();
    res.json({ success: true, data: { videos, count: videos.length }, error: null });
  } catch (error) {
    next(error);
  }
}

function listCategories(req, res, next) {
  try {
    void req;
    const categories = catalog.listCategories();
    res.json({ success: true, data: { categories }, error: null });
  } catch (error) {
    next(error);
  }
}

function listByCategory(req, res, next) {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) {
      throw new AppError('Category slug is required', 400);
    }
    const videos = catalog.listByCategory(slug);
    if (videos.length === 0) {
      throw new AppError('Category not found', 404);
    }
    res.json({ success: true, data: { slug, videos }, error: null });
  } catch (error) {
    next(error);
  }
}

function resolveByName(req, res, next) {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) {
      throw new AppError('Query "name" is required', 400);
    }
    const all = catalog.findAllUrlsByName(name);
    if (all.length === 0) {
      throw new AppError('Video not found', 404);
    }
    res.json({
      success: true,
      data: { name, slug: catalog.slugify(name), url: all[0], alternatives: all.slice(1) },
      error: null,
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listAll,
  listCategories,
  listByCategory,
  resolveByName,
};
