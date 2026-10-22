'use strict';
module.exports = function canonicalHTTPS(req, res, next) {
  if (req.hostname === 'myhai.org' && req.get('x-forwarded-proto') === 'http') {
    return res.redirect(308, 'https://myhai.org' + req.originalUrl);
  }
  next();
};
