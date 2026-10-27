"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookController = void 0;
const common_1 = require("@nestjs/common");
const mongoose = require("mongoose");
const https = require("https");
const http = require("http");

// ─── DB ───────────────────────────────────────────────────────────────────────
let _conn = null;
async function getDB() {
    if (!_conn || _conn.readyState !== 1) {
        _conn = await mongoose.createConnection(
            process.env.MONGO_URI || "mongodb://mongo:27017/heyform"
        ).asPromise();
    }
    return _conn;
}

async function getFormSettings(formId) {
    const db = await getDB();
    const form = await db.collection("formmodels").findOne(
        { _id: formId },
        { projection: { name: 1, "settings.webhookUrl": 1, "settings.pixelId": 1 } }
    );
    return form;
}

// ─── TRANSFORMER ──────────────────────────────────────────────────────────────

/**
 * Risolve il valore human-readable di una risposta qualunque.
 * Gestisce: short_text, long_text, email, phone_number, number, date,
 *           url, yes_no, rating, opinion_scale, multiple_choice (singola/multipla)
 */
function resolveValue(answer) {
    if (!answer) return '';

    const kind = answer.kind;
    const val  = answer.value;
    const props = answer.properties || {};

    // Tipi a valore diretto (stringa/numero)
    // HeyForm wrappa il valore in { value: ... } — gestiamo entrambi i casi
    if (
        kind === 'short_text'    ||
        kind === 'long_text'     ||
        kind === 'email'         ||
        kind === 'phone_number'  ||
        kind === 'number'        ||
        kind === 'date'          ||
        kind === 'url'           ||
        kind === 'yes_no'        ||
        kind === 'rating'        ||
        kind === 'opinion_scale' ||
        kind === 'nps'
    ) {
        // Se val è oggetto con .value dentro (formato HeyForm nativo)
        var raw = (val && typeof val === 'object' && val.value !== undefined) ? val.value : val;
        return raw !== undefined && raw !== null ? String(raw) : '';
    }

    // Multiple choice → risolvi choice ID → label
    if (kind === 'multiple_choice' || kind === 'picture_choice') {
        const chosen  = (val && val.value) ? val.value : [];
        const choices = props.choices || [];

        if (chosen.length === 0) return '';

        const labels = chosen.map(function(id) {
            // Se allowOther e l'id non corrisponde a nessuna choice → è testo libero
            const found = choices.find(function(c) { return c.id === id; });
            return found ? found.label : id;
        });

        return labels.join(', ');
    }

    // Fallback: serializza
    if (typeof val === 'object' && val !== null) return JSON.stringify(val);
    return val !== undefined && val !== null ? String(val) : '';
}

/**
 * Normalizza il titolo di un campo in una chiave snake_case usabile come
 * nome di campo custom in GHL (max 50 char, solo a-z0-9_).
 */
function titleToKey(title) {
    var t = Array.isArray(title) ? title[0] : (title || '');
    return t
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // rimuovi accenti
        .replace(/[^a-z0-9\s_]/g, '')                        // rimuovi punteggiatura
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 50);
}

/**
 * Heuristica per capire se un campo è "Nome", "Cognome", "Email", "Telefono"
 * in qualsiasi lingua ragionevole — così il contatto GHL viene creato correttamente.
 */
function detectStandardField(answer) {
    const kind  = answer.kind;
    const title = (Array.isArray(answer.title) ? answer.title[0] : (answer.title || '')).toLowerCase().trim();

    if (kind === 'email') return 'email';
    if (kind === 'phone_number') return 'phone';

    if (kind === 'short_text' || kind === 'long_text') {
        if (/^(nome|first.?name|firstname|prénom|vorname|nombre)$/.test(title)) return 'firstName';
        if (/^(cognome|last.?name|lastname|surname|nom|nachname|apellido)$/.test(title)) return 'lastName';
        if (/^(nome\s+e\s+cognome|full.?name|name\s+and\s+surname|nome\s+completo)$/.test(title)) return 'fullName';
        if (/^(azienda|company|empresa|entreprise|società|ragione\s+sociale)$/.test(title)) return 'companyName';
        if (/^(città|city|citta|ciudad|ville|stadt)$/.test(title)) return 'city';
        if (/^(indirizzo|address|adresse|dirección)$/.test(title)) return 'address';
        if (/^(cap|postal.?code|zip|postleitzahl|code\s+postal)$/.test(title)) return 'postalCode';
        if (/^(sito|website|sito\s+web|url|dominio)$/.test(title)) return 'website';
    }

    return null; // campo custom
}

/**
 * Trasforma il payload grezzo HeyForm in un oggetto piatto pronto per GHL.
 */
// ─── UTM / TRACKING HIDDEN FIELDS MAP ────────────────────────────────────────
// Mappa nome hidden field HeyForm → campo standard GHL
// I campi non presenti qui finiscono in customFields{}
var UTM_TO_GHL = {
    'utm_source':   'source',
    'utm_medium':   'medium',
    'utm_campaign': 'campaign',
    'utm_content':  'adContent',
    'utm_term':     'keyword'
};
// Campi che vanno in customFields (non hanno un campo nativo GHL)
var HIDDEN_TO_CUSTOM = [
    'fbclid',
    'gclid',
    'ttclid'
];

function transformPayload(payload) {
    const answers  = payload.answers      || [];
    const fields   = payload.fields       || [];
    const hidden   = payload.hiddenFields || [];
    const formId   = payload.formId       || '';
    const formName = payload.formName     || '';

    // Mappa fieldId → titolo (dai fields definition, più affidabile)
    const fieldTitleMap = {};
    fields.forEach(function(f) {
        fieldTitleMap[f.id] = f.title;
    });

    // Risultato base
    const result = {
        _formId:   formId,
        _formName: formName,
        _submissionId: payload.id || ''
    };

    // Campi standard GHL (verranno estratti dagli answer)
    // firstName, lastName, email, phone, companyName, ecc.
    const standard = {};
    const custom   = {};

    // ── Risposte del form ──────────────────────────────────────────────────────
    answers.forEach(function(answer) {
        const kind = answer.kind;

        // Salta thank_you e campi non-risposta
        if (kind === 'thank_you' || kind === 'statement' || kind === 'legal') return;

        // Usa il titolo dal fields definition se disponibile (più completo)
        const titleFromDef = fieldTitleMap[answer.id];
        const title = titleFromDef || answer.title || answer.id;
        answer.title = title; // normalizza per resolveValue

        const value = resolveValue(answer);
        if (value === '') return; // salta risposte vuote

        const stdField = detectStandardField(answer);

        if (stdField === 'fullName') {
            // Splitta "Mario Rossi" → firstName + lastName
            const parts = value.trim().split(/\s+/);
            standard['firstName'] = parts[0] || '';
            standard['lastName']  = parts.slice(1).join(' ') || '';
        } else if (stdField) {
            standard[stdField] = value;
        } else {
            // Campo custom: chiave derivata dal titolo
            const key = titleToKey(title);
            custom[key] = value;
        }
    });

    // ── Hidden fields (UTM, fbclid, ecc.) ────────────────────────────────────
    hidden.forEach(function(hf) {
        var id  = (hf.id    || '').toLowerCase().trim();
        var val = (hf.value !== undefined && hf.value !== null) ? String(hf.value).trim() : '';
        if (!id || !val) return; // salta vuoti

        if (UTM_TO_GHL[id]) {
            // UTM → campo standard GHL (source, medium, campaign, ecc.)
            standard[UTM_TO_GHL[id]] = val;
        } else if (HIDDEN_TO_CUSTOM.indexOf(id) !== -1) {
            // fbclid / gclid / ttclid → customFields
            custom[id] = val;
        } else {
            // Qualsiasi altro hidden field non mappato → customFields
            custom[titleToKey(id)] = val;
        }
    });

    // Merge: campi standard prima, poi custom
    Object.assign(result, standard, { customFields: custom });

    return result;
}

// ─── HTTP FORWARD ─────────────────────────────────────────────────────────────

function forwardToGHL(webhookUrl, payload) {
    return new Promise(function(resolve, reject) {
        const body = JSON.stringify(payload);
        const parsed = new URL(webhookUrl);
        const isHttps = parsed.protocol === 'https:';
        const lib = isHttps ? https : http;

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'User-Agent': 'HeyForm-Transformer/1.0'
            }
        };

        const req = lib.request(options, function(res) {
            let data = '';
            res.on('data', function(chunk) { data += chunk; });
            res.on('end', function() {
                resolve({ status: res.statusCode, body: data });
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, function() {
            req.destroy(new Error('GHL webhook timeout'));
        });
        req.write(body);
        req.end();
    });
}

function readBody(req) {
    return new Promise(function(resolve, reject) {
        // Già parsato da NestJS
        if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            return resolve(req.body);
        }
        const chunks = [];
        req.on('data', function(chunk) { chunks.push(chunk); });
        req.on('end', function() {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(JSON.parse(raw));
            } catch(e) {
                resolve({});
            }
        });
        req.on('error', function() { resolve({}); });
    });
}

// ─── CONTROLLER ───────────────────────────────────────────────────────────────

let WebhookController = class WebhookController {

    /**
     * POST /webhook/transform
     * Riceve il payload grezzo da HeyForm (via impostazioni webhook del form),
     * lo trasforma e lo forwarda al webhook GHL configurato nell'admin.
     */
    async transform(req, res) {
        try {
            const payload = await readBody(req);
            const formId  = payload.formId;

            if (!formId) {
                return res.status(400).json({ error: 'formId mancante nel payload' });
            }

            // Carica settings del form da MongoDB
            let webhookUrl = null;
            try {
                const form = await getFormSettings(formId);
                webhookUrl = form && form.settings && form.settings.webhookUrl
                    ? form.settings.webhookUrl
                    : null;
            } catch(dbErr) {
                console.error('[WebhookController] DB error:', dbErr.message);
            }

            // Trasforma sempre il payload
            const transformed = transformPayload(payload);

            // Log per debug
            console.log('[WebhookController] form:', formId, '| fields:', Object.keys(transformed).length);

            // Se non c'è webhook configurato → restituisce solo il payload trasformato
            if (!webhookUrl) {
                return res.json({
                    success: true,
                    forwarded: false,
                    reason: 'Nessun webhook GHL configurato per questo form',
                    transformed: transformed
                });
            }

            // Forward a GHL
            try {
                const ghlRes = await forwardToGHL(webhookUrl, transformed);
                console.log('[WebhookController] GHL response:', ghlRes.status);
                return res.json({
                    success: true,
                    forwarded: true,
                    ghlStatus: ghlRes.status,
                    transformed: transformed
                });
            } catch(fwdErr) {
                console.error('[WebhookController] Forward error:', fwdErr.message);
                return res.status(502).json({
                    success: false,
                    error: 'Errore forward a GHL: ' + fwdErr.message,
                    transformed: transformed
                });
            }

        } catch(e) {
            console.error('[WebhookController] Unexpected error:', e.message);
            return res.status(500).json({ error: e.message });
        }
    }

    /**
     * POST /webhook/test
     * Testa la trasformazione senza forwardare a GHL.
     * Utile per vedere come viene parsato un payload prima di configurare il webhook reale.
     */
    async test(req, res) {
        try {
            const payload = await readBody(req);
            const transformed = transformPayload(payload);
            return res.json({ success: true, transformed: transformed });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }
};

exports.WebhookController = WebhookController;

__decorate([
    (0, common_1.Post)('/webhook/transform'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], WebhookController.prototype, "transform", null);

__decorate([
    (0, common_1.Post)('/webhook/test'),
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], WebhookController.prototype, "test", null);

exports.WebhookController = WebhookController = __decorate([
    (0, common_1.Controller)()
], WebhookController);
