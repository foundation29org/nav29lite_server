'use strict'

const config = require('../config')
const crypto = require('crypto');

/**
 * Deriva la key usando el mismo algoritmo que crypto.createCipher (EVP_BytesToKey con MD5)
 * Esto mantiene compatibilidad con datos encriptados existentes
 * @param {string} password - La contraseña/secreto
 * @param {number} keyLen - Longitud de la key en bytes (32 para AES-256)
 * @returns {Buffer} - La key derivada
 */
function deriveKeyFromPassword(password, keyLen = 32) {
  let key = Buffer.alloc(0);
  let prev = Buffer.alloc(0);
  
  while (key.length < keyLen) {
    const hash = crypto.createHash('md5');
    hash.update(prev);
    hash.update(password, 'utf8');
    prev = hash.digest();
    key = Buffer.concat([key, prev]);
  }
  
  return key.slice(0, keyLen);
}

/**
 * Encripta datos
 * Compatible con Node 22+ usando createCipheriv
 */
function encrypt(data) {
  const key = deriveKeyFromPassword(config.SECRET_KEY_CRYPTO, 32);
  // ECB mode no usa IV, pero createCipheriv lo requiere - usamos buffer vacío
  const cipher = crypto.createCipheriv('aes-256-ecb', key, Buffer.alloc(0));
  return cipher.update(data, 'utf8', 'hex') + cipher.final('hex');
}

/**
 * Desencripta datos
 * Compatible con Node 22+ usando createDecipheriv
 */
function decrypt(data) {
  const key = deriveKeyFromPassword(config.SECRET_KEY_CRYPTO, 32);
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, Buffer.alloc(0));
  return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
}

module.exports = {
  encrypt,
  decrypt
}
