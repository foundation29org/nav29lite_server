/**
 * Sistema de throttling para emails de alertas de seguridad
 * Evita spam de emails por intentos de acceso no autorizados
 */

class EmailThrottle {
    constructor() {
        // Mapa para trackear IPs: { ip: { lastEmailSent: timestamp, attemptCount: number, attempts: [] } }
        this.ipTracking = new Map();
        
        // Configuración
        this.THROTTLE_TIME = 60 * 60 * 1000; // 1 hora en milisegundos
        this.MAX_ATTEMPTS_TO_STORE = 10; // Máximo de intentos a guardar por IP
        this.CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // Limpiar cada 6 horas
        
        // Limpiar datos antiguos periódicamente
        this.startCleanupTimer();
    }

    /**
     * Verifica si se debe enviar un email para esta IP
     * @param {string} ip - Dirección IP del cliente
     * @param {object} requestInfo - Información de la request
     * @returns {boolean} - true si se debe enviar el email
     */
    shouldSendEmail(ip, requestInfo) {
        const now = Date.now();
        const tracking = this.ipTracking.get(ip);

        if (!tracking) {
            // Primera vez que vemos esta IP
            this.ipTracking.set(ip, {
                lastEmailSent: now,
                attemptCount: 1,
                attempts: [this.createAttemptLog(requestInfo, now)]
            });
            return true;
        }

        // Incrementar contador de intentos
        tracking.attemptCount++;
        
        // Guardar el intento (limitado a MAX_ATTEMPTS_TO_STORE)
        if (tracking.attempts.length < this.MAX_ATTEMPTS_TO_STORE) {
            tracking.attempts.push(this.createAttemptLog(requestInfo, now));
        }

        // Verificar si ya pasó el tiempo de throttle
        const timeSinceLastEmail = now - tracking.lastEmailSent;
        
        if (timeSinceLastEmail >= this.THROTTLE_TIME) {
            // Ha pasado suficiente tiempo, enviar otro email
            tracking.lastEmailSent = now;
            return true;
        }

        // No enviar email, aún está en periodo de throttle
        console.log(`[EmailThrottle] Bloqueando email para IP ${ip}. Intentos: ${tracking.attemptCount}. Último email hace ${Math.round(timeSinceLastEmail / 1000 / 60)} minutos.`);
        return false;
    }

    /**
     * Obtiene información agregada de una IP para incluir en el email
     * @param {string} ip - Dirección IP
     * @returns {object} - Información agregada
     */
    getAggregatedInfo(ip) {
        const tracking = this.ipTracking.get(ip);
        
        if (!tracking) {
            return { attemptCount: 1, attempts: [] };
        }

        return {
            attemptCount: tracking.attemptCount,
            attempts: tracking.attempts,
            firstAttemptTime: tracking.attempts[0]?.timestamp,
            lastAttemptTime: tracking.attempts[tracking.attempts.length - 1]?.timestamp
        };
    }

    /**
     * Crea un log resumido del intento
     * @param {object} requestInfo - Información de la request
     * @param {number} timestamp - Timestamp del intento
     * @returns {object} - Log del intento
     */
    createAttemptLog(requestInfo, timestamp) {
        return {
            timestamp: new Date(timestamp).toISOString(),
            method: requestInfo.method,
            url: requestInfo.url,
            origin: requestInfo.origin,
            userAgent: requestInfo.headers?.['user-agent']
        };
    }

    /**
     * Limpia datos antiguos de IPs que no han intentado acceso recientemente
     */
    cleanup() {
        const now = Date.now();
        const maxAge = this.THROTTLE_TIME * 2; // Mantener datos por el doble del tiempo de throttle
        
        for (const [ip, tracking] of this.ipTracking.entries()) {
            if (now - tracking.lastEmailSent > maxAge) {
                this.ipTracking.delete(ip);
                console.log(`[EmailThrottle] Limpiando datos de IP ${ip}`);
            }
        }
    }

    /**
     * Inicia el timer de limpieza periódica
     */
    startCleanupTimer() {
        setInterval(() => {
            this.cleanup();
        }, this.CLEANUP_INTERVAL);
    }

    /**
     * Obtiene estadísticas generales
     * @returns {object} - Estadísticas
     */
    getStats() {
        const stats = {
            totalTrackedIPs: this.ipTracking.size,
            ips: []
        };

        for (const [ip, tracking] of this.ipTracking.entries()) {
            stats.ips.push({
                ip,
                attemptCount: tracking.attemptCount,
                lastEmailSent: new Date(tracking.lastEmailSent).toISOString()
            });
        }

        return stats;
    }
}

// Exportar instancia singleton
module.exports = new EmailThrottle();
