const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 5000;
const Stripe = require('stripe');

let firebaseAdmin = null;
try {
    firebaseAdmin = require('firebase-admin');
} catch (error) {
    console.warn('firebase-admin is not installed. Firebase token verification routes will be unavailable until it is added.');
}

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'estate-ease-dev-secret';
const JWT_EXPIRES_IN = '7d';
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const getFirebasePrivateKey = () => {
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;
    return rawKey ? rawKey.replace(/\\n/g, '\n') : '';
};

const canInitializeFirebaseAdmin = () => {
    return Boolean(
        firebaseAdmin
        && process.env.FIREBASE_PROJECT_ID
        && process.env.FIREBASE_CLIENT_EMAIL
        && getFirebasePrivateKey()
    );
};

const initializeFirebaseAdmin = () => {
    if (!canInitializeFirebaseAdmin()) {
        return false;
    }

    if (!firebaseAdmin.apps.length) {
        firebaseAdmin.initializeApp({
            credential: firebaseAdmin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: getFirebasePrivateKey(),
            }),
        });
    }

    return true;
};

const verifyFirebaseIdToken = async (token) => {
    if (!initializeFirebaseAdmin()) {
        const error = new Error('Firebase Admin SDK is not configured.');
        error.code = 'FIREBASE_ADMIN_NOT_CONFIGURED';
        throw error;
    }

    return firebaseAdmin.auth().verifyIdToken(token);
};

const buildApartmentData = (body, existingApartment = {}) => ({
    title: body.title || existingApartment.title,
    image: body.image || existingApartment.image,
    icon: body.icon || existingApartment.icon,
    shortDescription: body.shortDescription || existingApartment.shortDescription,
    overview: body.overview || existingApartment.overview,
    description: body.description || existingApartment.description,
    media: body.media || existingApartment.media || [],
    keyInformation: body.keyInformation || existingApartment.keyInformation || [],
    specs: body.specs || existingApartment.specs || [],
    rules: body.rules || existingApartment.rules || [],
    primaryAction: body.primaryAction || existingApartment.primaryAction || 'view',
    actions: body.actions || existingApartment.actions || ['view'],
    meta: {
        price: body?.meta?.price ?? existingApartment?.meta?.price ?? 0,
        date: body?.meta?.date ?? existingApartment?.meta?.date ?? new Date(),
        status: body?.meta?.status ?? existingApartment?.meta?.status ?? 'available',
        rating: body?.meta?.rating ?? existingApartment?.meta?.rating ?? 0,
        location: body?.meta?.location ?? existingApartment?.meta?.location ?? '',
        type: body?.meta?.type ?? existingApartment?.meta?.type ?? 'apartment',
    },
    isPublic: body.isPublic ?? existingApartment.isPublic ?? true,
});

const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${hash}`;
};

const verifyPassword = (password, storedPassword) => {
    const [salt, hash] = String(storedPassword || '').split(':');
    if (!salt || !hash) return false;

    const testHash = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(testHash, 'hex'));
};

const isStrongPassword = (password = '') => {
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/.test(password);
};

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
    const originalJson = res.json.bind(res);

    res.ok = (data = null, message = 'Success', statusCode = 200) => {
        return res.status(statusCode).json({
            success: true,
            message,
            data,
        });
    };

    res.fail = (message = 'Request failed', statusCode = 500, errorCode = 'SERVER_ERROR', details = null) => {
        return res.status(statusCode).json({
            success: false,
            message,
            errorCode,
            details,
        });
    };

    // Keep legacy res.json/res.status().json handlers consistent with the unified API shape.
    res.json = (payload) => {
        if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'success')) {
            return originalJson(payload);
        }

        const statusCode = res.statusCode || 200;

        if (statusCode >= 400) {
            const message = payload && typeof payload === 'object' && payload.message
                ? payload.message
                : 'Request failed';

            const details = payload && typeof payload === 'object'
                ? {
                    ...payload,
                    message: undefined,
                }
                : null;

            return originalJson({
                success: false,
                message,
                errorCode: 'REQUEST_FAILED',
                details,
            });
        }

        if (payload && typeof payload === 'object' && !Array.isArray(payload) && Object.prototype.hasOwnProperty.call(payload, 'message')) {
            const { message, ...rest } = payload;
            const hasData = Object.keys(rest).length > 0;

            return originalJson({
                success: true,
                message,
                data: hasData ? rest : null,
            });
        }

        return originalJson({
            success: true,
            message: 'Success',
            data: payload,
        });
    };

    next();
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uouce.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// MongoDB Client Setup
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: false,
    },
});

async function run() {
    try {
        // await client.connect();
        // console.log('Connected to MongoDB successfully!');

        // Collections
        const apartmentCollection = client.db('estateEase').collection('apartments');
        const agreementCollection = client.db('estateEase').collection('agreements');
        const paymentCollection = client.db('estateEase').collection('payments');
        const couponCollection = client.db('estateEase').collection('coupons');
        const userCollection = client.db('estateEase').collection('users');
        const announcementCollection = client.db('estateEase').collection('announcements');
        const reviewCollection = client.db('estateEase').collection('reviews');
        const sitePageCollection = client.db('estateEase').collection('sitePages');
        const blogCollection = client.db('estateEase').collection('blogs');
        const contactMessageCollection = client.db('estateEase').collection('contactMessages');
        const newsletterCollection = client.db('estateEase').collection('newsletters');

        (async () => {
            try {
                await apartmentCollection.createIndex({ isPublic: 1, createdAt: -1 });
                await apartmentCollection.createIndex({ 'meta.status': 1, 'meta.location': 1, 'meta.type': 1 });
                await apartmentCollection.createIndex({ 'meta.price': 1, 'meta.rating': -1 });
                await apartmentCollection.createIndex({ title: 'text', shortDescription: 'text', overview: 'text', description: 'text' });
                await reviewCollection.createIndex({ apartmentId: 1, createdAt: -1 });
                await sitePageCollection.createIndex({ slug: 1 }, { unique: true });
                await blogCollection.createIndex({ createdAt: -1 });
                await newsletterCollection.createIndex({ email: 1 }, { unique: true });
            } catch (indexError) {
                console.error('Index initialization failed. Continuing without blocking route setup.', indexError?.message || indexError);
            }
        })();

        const loginAttempts = new Map();

        const requireAuth = async (req, res, next) => {
            try {
                const authHeader = req.headers.authorization;

                if (!authHeader || !authHeader.startsWith('Bearer ')) {
                    return res.fail('Unauthorized. Missing token.', 401, 'AUTH_MISSING_TOKEN');
                }

                const token = authHeader.split(' ')[1];
                let decoded = null;

                try {
                    decoded = jwt.verify(token, JWT_SECRET);
                } catch (jwtError) {
                    try {
                        decoded = await verifyFirebaseIdToken(token);
                    } catch (firebaseError) {
                        return res.fail('Authorization check failed.', 401, 'AUTH_VERIFICATION_FAILED');
                    }
                }

                const email = decoded?.email;

                if (!email) {
                    return res.fail('Unauthorized token payload.', 401, 'AUTH_INVALID_TOKEN_PAYLOAD');
                }

                const user = await userCollection.findOne({ email: String(email) });

                if (!user) {
                    return res.fail('Unauthorized user.', 401, 'AUTH_USER_NOT_FOUND');
                }

                req.user = user;
                req.auth = {
                    email,
                    uid: decoded?.uid || null,
                    tokenType: decoded?.uid ? 'firebase' : 'jwt',
                };
                next();
            } catch (error) {
                res.fail('Authorization check failed.', 401, 'AUTH_VERIFICATION_FAILED');
            }
        };

        const requireRole = (roles = []) => (req, res, next) => {
            if (!req.user) {
                return res.fail('Unauthorized user.', 401, 'AUTH_USER_NOT_FOUND');
            }

            if (!roles.includes(req.user.role)) {
                return res.fail('Forbidden: insufficient role permission.', 403, 'AUTH_ROLE_FORBIDDEN');
            }

            next();
        };

        const validateObjectIdParam = (paramName = 'id') => (req, res, next) => {
            const value = req.params?.[paramName];

            if (!ObjectId.isValid(value)) {
                return res.fail(`Invalid ${paramName}`, 400, 'INVALID_OBJECT_ID');
            }

            next();
        };

        // Routes

        // **Apartments** - Get All Apartments
        app.get('/apartments', async (req, res) => {
            try {
                const {
                    search = '',
                    status,
                    location,
                    type,
                    minPrice,
                    maxPrice,
                    minRating,
                    sortBy = 'createdAt',
                    sortOrder = 'desc',
                    page = '1',
                    limit = '12',
                } = req.query;

                const currentPage = Math.max(1, parseInt(page) || 1);
                const perPage = Math.min(50, Math.max(1, parseInt(limit) || 12));
                const skip = (currentPage - 1) * perPage;

                const query = {
                    $or: [{ isPublic: true }, { isPublic: { $exists: false } }],
                };

                if (search.trim()) {
                    query.$or = [
                        { title: { $regex: search, $options: 'i' } },
                        { shortDescription: { $regex: search, $options: 'i' } },
                        { overview: { $regex: search, $options: 'i' } },
                    ];
                }

                if (status) query['meta.status'] = status;
                if (location) query['meta.location'] = location;
                if (type) query['meta.type'] = type;

                if (minPrice || maxPrice) {
                    query['meta.price'] = {};
                    if (minPrice) query['meta.price'].$gte = Number(minPrice);
                    if (maxPrice) query['meta.price'].$lte = Number(maxPrice);
                }

                if (minRating) {
                    query['meta.rating'] = { $gte: Number(minRating) };
                }

                const allowedSortFields = ['createdAt', 'meta.price', 'meta.rating', 'title', 'meta.date'];
                const finalSortBy = allowedSortFields.includes(sortBy) ? sortBy : 'createdAt';
                const finalSortOrder = sortOrder === 'asc' ? 1 : -1;

                const [apartments, total] = await Promise.all([
                    apartmentCollection
                        .find(query)
                        .sort({ [finalSortBy]: finalSortOrder })
                        .skip(skip)
                        .limit(perPage)
                        .toArray(),
                    apartmentCollection.countDocuments(query),
                ]);

                res.ok({
                    data: apartments,
                    pagination: {
                        page: currentPage,
                        limit: perPage,
                        total,
                        totalPages: Math.ceil(total / perPage),
                    },
                });
            } catch (error) {
                res.fail('Failed to fetch apartments', 500, 'APARTMENT_LIST_FAILED');
            }
        });

        app.get('/apartments/filters/options', async (req, res) => {
            try {
                const [statuses, locations, types] = await Promise.all([
                    apartmentCollection.distinct('meta.status', { $or: [{ isPublic: true }, { isPublic: { $exists: false } }] }),
                    apartmentCollection.distinct('meta.location', { $or: [{ isPublic: true }, { isPublic: { $exists: false } }] }),
                    apartmentCollection.distinct('meta.type', { $or: [{ isPublic: true }, { isPublic: { $exists: false } }] }),
                ]);

                res.json({
                    statuses,
                    locations,
                    types,
                    sortBy: ['createdAt', 'meta.price', 'meta.rating', 'title', 'meta.date'],
                    sortOrder: ['asc', 'desc'],
                });
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch apartment filter options' });
            }
        });

        app.post('/apartments', async (req, res) => {
            try {
                const apartment = buildApartmentData(req.body);

                if (!apartment.title || (!apartment.image && !apartment.icon)) {
                    return res.fail('Title and image/icon are required.', 400, 'APARTMENT_VALIDATION_FAILED');
                }

                const result = await apartmentCollection.insertOne({
                    ...apartment,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                res.ok({ apartmentId: result.insertedId }, 'Apartment created successfully', 201);
            } catch (error) {
                res.fail('Failed to create apartment', 500, 'APARTMENT_CREATE_FAILED');
            }
        });

        app.patch('/apartments/:id', validateObjectIdParam('id'), async (req, res) => {
            try {
                const { id } = req.params;
                const apartment = await apartmentCollection.findOne({ _id: new ObjectId(id) });

                if (!apartment) {
                    return res.fail('Apartment not found', 404, 'APARTMENT_NOT_FOUND');
                }

                const updatedApartment = buildApartmentData(req.body, apartment);

                await apartmentCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { ...updatedApartment, updatedAt: new Date() } }
                );

                res.ok(null, 'Apartment updated successfully');
            } catch (error) {
                res.fail('Failed to update apartment', 500, 'APARTMENT_UPDATE_FAILED');
            }
        });

        app.get('/apartments/:id', validateObjectIdParam('id'), async (req, res) => {
            try {
                const { id } = req.params;
                const apartment = await apartmentCollection.findOne({ _id: new ObjectId(id) });

                if (!apartment) {
                    return res.fail('Apartment not found', 404, 'APARTMENT_NOT_FOUND');
                }

                const relatedApartments = await apartmentCollection
                    .find({
                        _id: { $ne: new ObjectId(id) },
                        $or: [{ isPublic: true }, { isPublic: { $exists: false } }],
                        'meta.type': apartment?.meta?.type || 'apartment',
                    })
                    .sort({ 'meta.rating': -1, createdAt: -1 })
                    .limit(4)
                    .toArray();

                res.ok({
                    item: apartment,
                    sections: {
                        overview: apartment.overview || apartment.description || '',
                        description: apartment.description || apartment.overview || '',
                        keyInformation: apartment.keyInformation || [],
                        specs: apartment.specs || [],
                        rules: apartment.rules || [],
                        media: apartment.media || [],
                        relatedItems: relatedApartments,
                    },
                    actions: apartment.actions || ['view'],
                });
            } catch (error) {
                res.fail('Failed to fetch apartment details', 500, 'APARTMENT_DETAILS_FAILED');
            }
        });

        app.get('/apartments/:id/reviews', validateObjectIdParam('id'), async (req, res) => {
            try {
                const { id } = req.params;
                const reviews = await reviewCollection.find({ apartmentId: id }).sort({ createdAt: -1 }).toArray();

                res.ok(reviews, 'Apartment reviews fetched successfully');
            } catch (error) {
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.fail('Invalid apartment id', 400, 'INVALID_APARTMENT_ID');
                }

                res.fail('Failed to fetch apartment reviews', 500, 'APARTMENT_REVIEW_LIST_FAILED');
            }
        });

        app.post('/apartments/:id/reviews', validateObjectIdParam('id'), async (req, res) => {
            try {
                const { id } = req.params;
                const { userName, userEmail, comment, rating } = req.body;

                if (!comment || !String(comment).trim()) {
                    return res.fail('Comment is required', 400, 'REVIEW_VALIDATION_FAILED');
                }

                const newReview = {
                    apartmentId: id,
                    userName: userName || 'Anonymous',
                    userEmail: userEmail || '',
                    comment,
                    rating: Number(rating) || 0,
                    createdAt: new Date(),
                };

                await reviewCollection.insertOne(newReview);

                const reviews = await reviewCollection.find({ apartmentId: id }).toArray();
                const totalRating = reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0);
                const averageRating = reviews.length ? totalRating / reviews.length : 0;

                await apartmentCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { 'meta.rating': averageRating, updatedAt: new Date() } }
                );

                res.ok(null, 'Review added successfully', 201);
            } catch (error) {
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.fail('Invalid apartment id', 400, 'INVALID_APARTMENT_ID');
                }

                res.fail('Failed to add review', 500, 'REVIEW_CREATE_FAILED');
            }
        });

        app.post('/apartments/:id/actions', validateObjectIdParam('id'), async (req, res) => {
            try {
                const { id } = req.params;
                const { action, userEmail } = req.body;

                if (!action) {
                    return res.fail('Action is required', 400, 'APARTMENT_ACTION_VALIDATION_FAILED');
                }

                const apartment = await apartmentCollection.findOne({ _id: new ObjectId(id) });
                if (!apartment) {
                    return res.fail('Apartment not found', 404, 'APARTMENT_NOT_FOUND');
                }

                await apartmentCollection.updateOne(
                    { _id: new ObjectId(id) },
                    {
                        $inc: { [`stats.${action}Count`]: 1 },
                        $push: {
                            actionLogs: {
                                action,
                                userEmail: userEmail || '',
                                createdAt: new Date(),
                            },
                        },
                        $set: { updatedAt: new Date() },
                    }
                );

                res.ok(null, 'Action recorded successfully');
            } catch (error) {
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.fail('Invalid apartment id', 400, 'INVALID_APARTMENT_ID');
                }

                res.fail('Failed to record action', 500, 'APARTMENT_ACTION_FAILED');
            }
        });

        app.post(['/auth/register', '/register'], async (req, res) => {
            try {
                const { email, password, displayName } = req.body;

                if (!email || !password || !displayName) {
                    return res.fail('Email, password and display name are required.', 400, 'AUTH_REGISTER_VALIDATION_FAILED');
                }

                if (!isStrongPassword(password)) {
                    return res.fail(
                        'Password must be at least 8 chars and include uppercase, lowercase, number, and special character.',
                        400,
                        'AUTH_WEAK_PASSWORD'
                    );
                }

                const existingUser = await userCollection.findOne({ email });
                if (existingUser) {
                    return res.fail('User already exists.', 409, 'AUTH_USER_EXISTS');
                }

                const newUser = {
                    email,
                    displayName,
                    role: 'user',
                    password: hashPassword(password),
                    lastLogin: new Date(),
                    createdAt: new Date(),
                };

                const result = await userCollection.insertOne(newUser);
                const token = jwt.sign(
                    { email: newUser.email, role: newUser.role },
                    JWT_SECRET,
                    { expiresIn: JWT_EXPIRES_IN }
                );

                res.ok({ userId: result.insertedId, token }, 'User registered successfully', 201);
            } catch (error) {
                res.fail('Failed to register user', 500, 'AUTH_REGISTER_FAILED');
            }
        });

        app.post(['/auth/login', '/login'], async (req, res) => {
            try {
                const { email, password } = req.body;
                const attemptKey = `${req.ip || 'unknown-ip'}:${email || 'no-email'}`;
                const currentTime = Date.now();
                const attemptData = loginAttempts.get(attemptKey);

                if (attemptData && currentTime - attemptData.firstAttemptAt < LOGIN_ATTEMPT_WINDOW_MS && attemptData.count >= MAX_LOGIN_ATTEMPTS) {
                    return res.fail('Too many login attempts. Please try again later.', 429, 'AUTH_RATE_LIMITED');
                }

                if (attemptData && currentTime - attemptData.firstAttemptAt >= LOGIN_ATTEMPT_WINDOW_MS) {
                    loginAttempts.delete(attemptKey);
                }

                if (!email || !password) {
                    return res.fail('Email and password are required.', 400, 'AUTH_LOGIN_VALIDATION_FAILED');
                }

                const user = await userCollection.findOne({ email });
                if (!user || !user.password) {
                    const failedData = loginAttempts.get(attemptKey);
                    if (!failedData) {
                        loginAttempts.set(attemptKey, { count: 1, firstAttemptAt: currentTime });
                    } else {
                        loginAttempts.set(attemptKey, { ...failedData, count: failedData.count + 1 });
                    }
                    return res.fail('Invalid credentials.', 401, 'AUTH_INVALID_CREDENTIALS');
                }

                const isValidPassword = verifyPassword(password, user.password);
                if (!isValidPassword) {
                    const failedData = loginAttempts.get(attemptKey);
                    if (!failedData) {
                        loginAttempts.set(attemptKey, { count: 1, firstAttemptAt: currentTime });
                    } else {
                        loginAttempts.set(attemptKey, { ...failedData, count: failedData.count + 1 });
                    }
                    return res.fail('Invalid credentials.', 401, 'AUTH_INVALID_CREDENTIALS');
                }

                loginAttempts.delete(attemptKey);

                await userCollection.updateOne(
                    { email },
                    { $set: { lastLogin: new Date() } }
                );

                const token = jwt.sign(
                    { email: user.email, role: user.role || 'user' },
                    JWT_SECRET,
                    { expiresIn: JWT_EXPIRES_IN }
                );

                res.ok({
                    token,
                    user: {
                        email: user.email,
                        displayName: user.displayName,
                        role: user.role || 'user',
                    },
                }, 'Login successful');
            } catch (error) {
                res.fail('Failed to login user', 500, 'AUTH_LOGIN_FAILED');
            }
        });

        app.post(['/jwt', '/auth/token', '/auth/firebase-token'], async (req, res) => {
            try {
                const authHeader = req.headers.authorization;
                const bodyToken = req.body?.firebaseToken || req.body?.token || req.body?.idToken;
                const firebaseToken = bodyToken || (authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : '');
                const requestedEmail = String(req.body?.email || '').trim().toLowerCase();

                if (!firebaseToken) {
                    return res.fail('Firebase token is required.', 400, 'AUTH_FIREBASE_TOKEN_REQUIRED');
                }

                const decoded = await verifyFirebaseIdToken(firebaseToken);
                const tokenEmail = String(decoded?.email || '').trim().toLowerCase();

                if (!tokenEmail) {
                    return res.fail('Firebase token does not include an email address.', 401, 'AUTH_FIREBASE_EMAIL_MISSING');
                }

                if (requestedEmail && requestedEmail !== tokenEmail) {
                    return res.fail('Token email mismatch.', 401, 'AUTH_FIREBASE_EMAIL_MISMATCH');
                }

                const existingUser = await userCollection.findOne({ email: tokenEmail });
                if (!existingUser) {
                    await userCollection.insertOne({
                        email: tokenEmail,
                        displayName: decoded?.name || req.body?.displayName || '',
                        role: req.body?.role || 'user',
                        firebaseUid: decoded?.uid || '',
                        lastLogin: new Date(),
                        createdAt: new Date(),
                    });
                } else {
                    await userCollection.updateOne(
                        { email: tokenEmail },
                        {
                            $set: {
                                firebaseUid: decoded?.uid || existingUser.firebaseUid || '',
                                displayName: decoded?.name || req.body?.displayName || existingUser.displayName || '',
                                lastLogin: new Date(),
                            },
                        }
                    );
                }

                const currentUser = await userCollection.findOne({ email: tokenEmail });
                const appToken = jwt.sign(
                    {
                        email: tokenEmail,
                        uid: decoded?.uid || null,
                        role: currentUser?.role || 'user',
                    },
                    JWT_SECRET,
                    { expiresIn: JWT_EXPIRES_IN }
                );

                res.ok({
                    token: appToken,
                    user: {
                        email: currentUser?.email || tokenEmail,
                        displayName: currentUser?.displayName || decoded?.name || '',
                        role: currentUser?.role || 'user',
                    },
                }, 'Backend token generated successfully');
            } catch (error) {
                if (error?.code === 'FIREBASE_ADMIN_NOT_CONFIGURED') {
                    return res.fail(
                        'Firebase Admin SDK is not configured on the server.',
                        500,
                        'AUTH_FIREBASE_ADMIN_NOT_CONFIGURED'
                    );
                }

                res.fail('Invalid Firebase token.', 401, 'AUTH_FIREBASE_TOKEN_INVALID');
            }
        });

        app.get('/dashboard/menu', requireAuth, (req, res) => {
            const role = req.user?.role || 'user';

            if (role === 'admin' || role === 'manager') {
                return res.json({
                    role,
                    items: ['overview', 'manage-users', 'manage-agreements', 'manage-coupons', 'manage-announcements'],
                });
            }

            res.json({
                role,
                items: ['overview', 'my-profile', 'my-agreements'],
            });
        });

        app.get('/public/overview', async (req, res) => {
            try {
                const [totalApartments, totalAnnouncements, totalPublishedBlogs, totalReviews] = await Promise.all([
                    apartmentCollection.countDocuments({ $or: [{ isPublic: true }, { isPublic: { $exists: false } }] }),
                    announcementCollection.countDocuments(),
                    blogCollection.countDocuments({ isPublished: { $ne: false } }),
                    reviewCollection.countDocuments(),
                ]);

                const ratingData = await reviewCollection.aggregate([
                    {
                        $group: {
                            _id: null,
                            avgRating: { $avg: { $ifNull: ['$rating', 0] } },
                        },
                    },
                ]).toArray();

                const averageRating = ratingData.length ? Number(ratingData[0].avgRating || 0) : 0;

                res.ok({
                    totalApartments,
                    totalAnnouncements,
                    totalPublishedBlogs,
                    totalReviews,
                    averageRating,
                }, 'Public overview fetched successfully');
            } catch (error) {
                res.fail('Failed to fetch public overview', 500, 'PUBLIC_OVERVIEW_FAILED');
            }
        });

        app.get('/dashboard/overview', requireAuth, async (req, res) => {
            try {
                const role = req.user?.role || 'user';

                if (role === 'admin' || role === 'manager') {
                    const [totalUsers, totalApartments, pendingAgreements, totalPayments] = await Promise.all([
                        userCollection.countDocuments(),
                        apartmentCollection.countDocuments(),
                        agreementCollection.countDocuments({ status: 'pending' }),
                        paymentCollection.countDocuments(),
                    ]);

                    return res.json({
                        role,
                        cards: {
                            totalUsers,
                            totalApartments,
                            pendingAgreements,
                            totalPayments,
                        },
                    });
                }

                const [myAgreements, myPayments] = await Promise.all([
                    agreementCollection.countDocuments({ userEmail: req.user.email }),
                    paymentCollection.countDocuments({ userEmail: req.user.email }),
                ]);

                res.json({
                    role,
                    cards: {
                        myAgreements,
                        myPayments,
                        accountRole: role,
                    },
                });
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch dashboard overview' });
            }
        });

        app.get('/dashboard/charts', requireAuth, async (req, res) => {
            try {
                const role = req.user?.role || 'user';

                if (role === 'admin' || role === 'manager') {
                    const [agreementStatuses, apartmentTypes] = await Promise.all([
                        agreementCollection.aggregate([
                            { $group: { _id: '$status', count: { $sum: 1 } } },
                        ]).toArray(),
                        apartmentCollection.aggregate([
                            { $group: { _id: '$meta.type', count: { $sum: 1 } } },
                        ]).toArray(),
                    ]);

                    return res.json({
                        barChart: agreementStatuses,
                        pieChart: apartmentTypes,
                    });
                }

                const myAgreementStatus = await agreementCollection.aggregate([
                    { $match: { userEmail: req.user.email } },
                    { $group: { _id: '$status', count: { $sum: 1 } } },
                ]).toArray();

                res.json({
                    barChart: myAgreementStatus,
                    pieChart: [],
                });
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch chart data' });
            }
        });

        app.get('/dashboard/table', requireAuth, async (req, res) => {
            try {
                const role = req.user?.role || 'user';

                if (role === 'admin' || role === 'manager') {
                    const rows = await agreementCollection.find().sort({ createdAt: -1 }).limit(10).toArray();
                    return res.json(rows);
                }

                const rows = await paymentCollection.find({ userEmail: req.user.email }).sort({ paymentDate: -1 }).limit(10).toArray();
                res.json(rows);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch table data' });
            }
        });

        app.get('/dashboard/profile', requireAuth, async (req, res) => {
            try {
                const user = await userCollection.findOne(
                    { email: req.user.email },
                    { projection: { password: 0 } }
                );

                res.json(user);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch profile' });
            }
        });

        app.patch('/dashboard/profile', requireAuth, async (req, res) => {
            try {
                const { displayName, phone, address, photoURL } = req.body;

                await userCollection.updateOne(
                    { email: req.user.email },
                    {
                        $set: {
                            ...(displayName ? { displayName } : {}),
                            ...(phone ? { phone } : {}),
                            ...(address ? { address } : {}),
                            ...(photoURL ? { photoURL } : {}),
                            updatedAt: new Date(),
                        },
                    }
                );

                res.json({ message: 'Profile updated successfully' });
            } catch (error) {
                res.status(500).json({ message: 'Failed to update profile' });
            }
        });

        app.get('/pages/:slug', async (req, res) => {
            try {
                const { slug } = req.params;
                const page = await sitePageCollection.findOne({ slug, isPublished: { $ne: false } });

                if (!page) {
                    return res.status(404).json({ message: 'Page not found' });
                }

                res.json(page);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch page content' });
            }
        });

        app.put('/pages/:slug', requireAuth, requireRole(['admin']), async (req, res) => {
            try {
                const { slug } = req.params;
                const { title, content, sections, isPublished = true } = req.body;

                await sitePageCollection.updateOne(
                    { slug },
                    {
                        $set: {
                            slug,
                            title: title || slug,
                            content: content || '',
                            sections: sections || [],
                            isPublished,
                            updatedAt: new Date(),
                        },
                        $setOnInsert: { createdAt: new Date() },
                    },
                    { upsert: true }
                );

                res.json({ message: 'Page saved successfully' });
            } catch (error) {
                res.status(500).json({ message: 'Failed to save page content' });
            }
        });

        app.get('/blogs', async (req, res) => {
            try {
                const page = Math.max(1, parseInt(req.query.page) || 1);
                const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
                const skip = (page - 1) * limit;

                const [data, total] = await Promise.all([
                    blogCollection
                        .find({ isPublished: { $ne: false } })
                        .sort({ createdAt: -1 })
                        .skip(skip)
                        .limit(limit)
                        .toArray(),
                    blogCollection.countDocuments({ isPublished: { $ne: false } }),
                ]);

                res.ok({
                    data,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages: Math.ceil(total / limit),
                    },
                }, 'Blogs fetched successfully');
            } catch (error) {
                res.fail('Failed to fetch blogs', 500, 'BLOG_LIST_FAILED');
            }
        });

        app.get('/blogs/:id', validateObjectIdParam('id'), async (req, res) => {
            try {
                const { id } = req.params;
                const blog = await blogCollection.findOne({ _id: new ObjectId(id), isPublished: { $ne: false } });

                if (!blog) {
                    return res.fail('Blog not found', 404, 'BLOG_NOT_FOUND');
                }

                res.ok(blog, 'Blog details fetched successfully');
            } catch (error) {
                res.fail('Failed to fetch blog details', 500, 'BLOG_DETAILS_FAILED');
            }
        });

        app.post('/blogs', requireAuth, requireRole(['admin']), async (req, res) => {
            try {
                const { title, coverImage, summary, content, tags = [], isPublished = true } = req.body;

                if (!title || !summary) {
                    return res.fail('Title and summary are required', 400, 'BLOG_VALIDATION_FAILED');
                }

                const result = await blogCollection.insertOne({
                    title,
                    coverImage: coverImage || '',
                    summary,
                    content: content || '',
                    tags,
                    isPublished,
                    authorEmail: req.user.email,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                res.ok({ blogId: result.insertedId }, 'Blog created successfully', 201);
            } catch (error) {
                res.fail('Failed to create blog', 500, 'BLOG_CREATE_FAILED');
            }
        });

        app.post('/contact-messages', async (req, res) => {
            try {
                const { name, email, subject, message } = req.body;

                if (!name || !email || !message) {
                    return res.status(400).json({ message: 'Name, email and message are required' });
                }

                await contactMessageCollection.insertOne({
                    name,
                    email,
                    subject: subject || '',
                    message,
                    status: 'new',
                    createdAt: new Date(),
                });

                res.status(201).json({ message: 'Contact message submitted successfully' });
            } catch (error) {
                res.status(500).json({ message: 'Failed to submit contact message' });
            }
        });

        app.post('/newsletter/subscribe', async (req, res) => {
            try {
                const { email } = req.body;

                if (!email) {
                    return res.status(400).json({ message: 'Email is required' });
                }

                const existing = await newsletterCollection.findOne({ email });
                if (existing) {
                    return res.json({ message: 'Already subscribed' });
                }

                await newsletterCollection.insertOne({
                    email,
                    createdAt: new Date(),
                });

                res.status(201).json({ message: 'Newsletter subscription successful' });
            } catch (error) {
                res.status(500).json({ message: 'Failed to subscribe newsletter' });
            }
        });

        app.post('/agreements', async (req, res) => {
            const { userName, userEmail, floorNo, blockName, apartmentNo, rent } = req.body;

            try {
                // Check if the user is an admin
                const user = await userCollection.findOne({ email: userEmail }); // Assuming userCollection contains user data
                if (user?.role === 'admin') {
                    return res.status(403).json({ message: 'Admins cannot create agreements.' });
                }

                // Check if the user already has an existing agreement
                const existingAgreement = await agreementCollection.findOne({ userEmail });
                if (existingAgreement) {
                    return res.status(400).json({ message: 'User already has an agreement.' });
                }

                const newAgreement = {
                    userName,
                    userEmail,
                    floorNo,
                    blockName,
                    apartmentNo,
                    rent,
                    status: 'pending',
                    createdAt: new Date(),
                };

                const result = await agreementCollection.insertOne(newAgreement);
                res.status(201).json({ message: 'Agreement created successfully', agreementId: result.insertedId });
            } catch (error) {
                res.status(500).json({ message: 'Failed to create agreement' });
            }
        });

        // Agreements related apis
        app.get('/agreements', (req, res) => {
            agreementCollection.find({ status: "pending" }).toArray()
                .then(agreements => {
                    res.status(200).json(agreements);
                })
                .catch(error => {
                    console.error('Error fetching agreements:', error);
                    res.status(500).json({ message: 'Failed to fetch agreements' });
                });
        });

        app.get('/agreements/:email', async (req, res) => {
            const { email } = req.params;

            try {
                const agreement = await agreementCollection.findOne({ userEmail: email });
                if (!agreement) return res.status(404).json({ message: 'No agreement found.' });
                res.json(agreement);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch agreement details' });
            }
        });

        // **Payments**
        app.post('/payments', async (req, res) => {
            const { userEmail, floorNo, blockName, apartmentNo, originalRent, finalRent, discount, month } = req.body;

            try {
                const newPayment = {
                    userEmail,
                    floorNo,
                    blockName,
                    apartmentNo,
                    originalRent,
                    finalRent,
                    discount,
                    month,
                    paymentDate: new Date(),
                };

                const result = await paymentCollection.insertOne(newPayment);
                res.ok({ paymentId: result.insertedId }, 'Payment recorded successfully', 201);
            } catch (error) {
                res.fail('Failed to record payment', 500, 'PAYMENT_CREATE_FAILED');
            }
        });

        app.get('/payments/:email', async (req, res) => {
            const { email } = req.params;

            try {
                const payments = await paymentCollection.find({ userEmail: email }).toArray();
                res.ok(payments, 'Payment history fetched successfully');
            } catch (error) {
                res.fail('Failed to fetch payment history', 500, 'PAYMENT_LIST_FAILED');
            }
        });

        // **Coupons**
        app.get('/coupons/:coupon', async (req, res) => {
            const { coupon } = req.params;

            try {
                const couponDetails = await couponCollection.findOne({ code: coupon });
                if (!couponDetails || new Date(couponDetails.expiration
                ) < new Date()) {
                    return res.fail('Invalid or expired coupon', 404, 'COUPON_INVALID_OR_EXPIRED');
                }
                res.ok(couponDetails, 'Coupon validated successfully');
            } catch (error) {
                res.fail('Failed to validate coupon', 500, 'COUPON_VALIDATE_FAILED');
            }
        });
        app.post('/coupons', requireAuth, requireRole(['admin']), async (req, res) => {
            const { code, discount, expiration, description
            } = req.body;

            try {
                const newCoupon = {
                    code, discount, expiration, description
                };
                const result = await couponCollection.insertOne(newCoupon);
                res.ok({ couponId: result.insertedId }, 'Coupon created successfully', 201);
            } catch (error) {
                res.fail('Failed to create coupon', 500, 'COUPON_CREATE_FAILED');
            }
        });
        app.get('/coupons', (req, res) => {
            couponCollection.find().toArray()
                .then(coupons => {
                    res.ok(coupons, 'Coupons fetched successfully');
                })
                .catch(error => {
                    console.error('Error fetching coupons:', error);
                    res.fail('Failed to fetch coupons', 500, 'COUPON_LIST_FAILED');
                });
        })
        app.put('/coupons/:id', requireAuth, requireRole(['admin']), validateObjectIdParam('id'), (req, res) => {
            const { id } = req.params;
            const { code, discount, expiration, description } = req.body;

            couponCollection.updateOne(
                { _id: new ObjectId(id) },
                {
                    $set: {
                        code,
                        discount,
                        expiration,
                        description
                    }
                }
            )
                .then(result => {
                    if (result.matchedCount === 0) {
                        res.fail('Coupon not found', 404, 'COUPON_NOT_FOUND');
                    } else {
                        res.ok(null, 'Coupon updated successfully');
                    }
                })
                .catch(error => res.fail('Failed to update coupon', 500, 'COUPON_UPDATE_FAILED'));
        });
        app.delete('/coupons/:id', requireAuth, requireRole(['admin']), validateObjectIdParam('id'), (req, res) => {
            const { id } = req.params;

            couponCollection.deleteOne({ _id: new ObjectId(id) })
                .then(result => {
                    if (result.deletedCount === 0) {
                        res.fail('Coupon not found', 404, 'COUPON_NOT_FOUND');
                    } else {
                        res.ok(null, 'Coupon deleted successfully');
                    }
                })
                .catch(error => res.fail('Failed to delete coupon', 500, 'COUPON_DELETE_FAILED'));
        });
        // users related apis
        app.post('/users', async (req, res) => {
            const { email, displayName, lastLogin, role } = req.body;
            console.log(email, displayName)

            const existingUser = await userCollection.findOne({ email });

            if (existingUser) {
                const result = await userCollection.updateOne(
                    { email },
                    { $set: { lastLogin: new Date(lastLogin) } }
                );
                res.json({ message: 'User login time updated successfully', result });
            } else {
                const newUser = { email, displayName, role: role || 'user', lastLogin: new Date(lastLogin) };
                console.log("inserted data", newUser);
                const result = await userCollection.insertOne(newUser);
                console.log("user", result);
                res.status(201).json({ message: 'User created successfully', userId: result.insertedId });
            }
        });
        app.get('/users', async (req, res) => {
            try {
                const users = await userCollection.find().toArray();
                res.json(users);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch users' });
            }
        });
        app.get('/users/:email', async (req, res) => {
            const { email } = req.params;

            try {
                const user = await userCollection.findOne({ email });
                if (!user) {
                    return res.status(404).json({ message: 'User not found' });
                }
                res.json(user);
            } catch (error) {
                res.status(500).json({ message: 'Error fetching user details', error });
            }
        });

        // Update User Role to "user"
        app.put('/users/:id', requireAuth, requireRole(['admin']), validateObjectIdParam('id'), async (req, res) => {
            const { id } = req.params;
            const { role } = req.body;

            try {
                const result = await userCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { role } }
                );

                if (result.modifiedCount === 1) {
                    res.json({ message: 'User role updated successfully' });
                } else {
                    res.status(404).json({ message: 'User not found' });
                }
            } catch (error) {
                console.error('Error updating user role:', error);
                res.status(500).json({ message: 'Failed to update user role' });
            }
        });
        // Post route for creating an announcement
        app.post('/announcements', (req, res) => {
            const { title, description, createdAt } = req.body;

            const newAnnouncement = {
                title,
                description,
                createdAt,
            };

            announcementCollection.insertOne(newAnnouncement)
                .then(result => {
                    res.ok({ announcementId: result.insertedId }, 'Announcement created successfully', 201);
                })
                .catch(error => {
                    console.error(error);
                    res.fail('Failed to create announcement', 500, 'ANNOUNCEMENT_CREATE_FAILED');
                });
        });
        app.get('/announcements', (req, res) => {
            announcementCollection.find().toArray()
                .then(announcements => {
                    res.ok(announcements, 'Announcements fetched successfully');
                })
                .catch(error => {
                    console.error(error);
                    res.fail('Failed to fetch announcements', 500, 'ANNOUNCEMENT_LIST_FAILED');
                });
        });
        app.get('/reviews', async (req, res) => {
            try {
                const reviews = await reviewCollection.find().toArray();
                res.ok(reviews, 'Reviews fetched successfully');
            } catch (error) {
                res.fail('Failed to fetch reviews', 500, 'REVIEW_LIST_FAILED');
            }
        });
        app.post('/create-payment-intent', async (req, res) => {
            try {
                const { price } = req.body;
                const amount = parseInt(price * 100);

                if (!amount || amount <= 0) {
                    return res.fail('Valid price is required', 400, 'PAYMENT_INTENT_VALIDATION_FAILED');
                }

                const paymentIntent = await stripe.paymentIntents.create({
                    amount,
                    currency: 'usd',
                    payment_method_types: ['card'],
                });

                res.ok({
                    clientSecret: paymentIntent.client_secret,
                }, 'Payment intent created successfully');
            } catch (error) {
                res.fail('Failed to create payment intent', 500, 'PAYMENT_INTENT_FAILED');
            }
        });


        // Accept or Reject Agreement - Combined
        app.put('/agreements/:id/update', requireAuth, requireRole(['admin', 'manager']), validateObjectIdParam('id'), (req, res) => {
            const { id } = req.params;
            const { status, role } = req.body;

            // Validate incoming data
            if (!status) {
                return res.status(400).json({ message: 'Status is required.' });
            }

            agreementCollection.findOne({ _id: new ObjectId(id) })
                .then(agreement => {
                    if (!agreement) {
                        return res.status(404).json({ message: 'Agreement not found.' });
                    }

                    // Update agreement's status
                    agreementCollection.updateOne(
                        { _id: new ObjectId(id) },
                        { $set: { status } }
                    )
                        .then(() => {
                            if (status === 'accepted' && role) {
                                // Update user's role
                                userCollection.updateOne(
                                    { email: agreement.userEmail },
                                    { $set: { role } }
                                )
                                    .then(() => {
                                        res.status(200).json({ message: `Agreement ${status} and user role updated.` });
                                    })
                                    .catch(error => {
                                        console.error('Error updating user role:', error);
                                        res.status(500).json({ message: 'Failed to update user role.' });
                                    });
                            } else if (status === 'rejected') {
                                res.status(200).json({ message: `Agreement ${status}.` });
                            } else {
                                res.status(400).json({ message: 'Invalid request parameters.' });
                            }
                        })
                        .catch(error => {
                            console.error('Error updating agreement status:', error);
                            res.status(500).json({ message: 'Failed to update agreement status.' });
                        });
                })
                .catch(error => {
                    console.error('Error finding agreement:', error);
                    res.status(500).json({ message: 'Failed to fetch agreement.' });
                });
        });



    } finally {
        // Uncomment if you wish to close the client manually
        // await client.close();
    }
}

run().catch(console.dir);

// Root Endpoint
app.get('/', (req, res) => {
    res.ok({ service: 'EstateEase Backend', status: 'running' }, 'EstateEase Backend is Running');
});

app.listen(port, () => {
    console.log(`Backend is running at: http://localhost:${port}`);
});
