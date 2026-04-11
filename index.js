const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const crypto = require('crypto');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 5000;
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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

// Middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uouce.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// MongoDB Client Setup
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
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

        await apartmentCollection.createIndex({ isPublic: 1, createdAt: -1 });
        await apartmentCollection.createIndex({ 'meta.status': 1, 'meta.location': 1, 'meta.type': 1 });
        await apartmentCollection.createIndex({ 'meta.price': 1, 'meta.rating': -1 });
        await apartmentCollection.createIndex({ title: 'text', shortDescription: 'text', overview: 'text', description: 'text' });
        await reviewCollection.createIndex({ apartmentId: 1, createdAt: -1 });

        const requireAuth = async (req, res, next) => {
            try {
                const email = req.headers['x-user-email'];

                if (!email) {
                    return res.status(401).json({ message: 'Unauthorized. Missing user email header.' });
                }

                const user = await userCollection.findOne({ email: String(email) });

                if (!user) {
                    return res.status(401).json({ message: 'Unauthorized user.' });
                }

                req.user = user;
                next();
            } catch (error) {
                res.status(500).json({ message: 'Authorization check failed.' });
            }
        };

        const requireRole = (roles = []) => (req, res, next) => {
            if (!req.user) {
                return res.status(401).json({ message: 'Unauthorized user.' });
            }

            if (!roles.includes(req.user.role)) {
                return res.status(403).json({ message: 'Forbidden: insufficient role permission.' });
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

                const query = { isPublic: true };

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

                res.json({
                    data: apartments,
                    pagination: {
                        page: currentPage,
                        limit: perPage,
                        total,
                        totalPages: Math.ceil(total / perPage),
                    },
                });
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch apartments' });
            }
        });

        app.get('/apartments/filters/options', async (req, res) => {
            try {
                const [statuses, locations, types] = await Promise.all([
                    apartmentCollection.distinct('meta.status', { isPublic: true }),
                    apartmentCollection.distinct('meta.location', { isPublic: true }),
                    apartmentCollection.distinct('meta.type', { isPublic: true }),
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
                    return res.status(400).json({ message: 'Title and image/icon are required.' });
                }

                const result = await apartmentCollection.insertOne({
                    ...apartment,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                });

                res.status(201).json({ message: 'Apartment created successfully', apartmentId: result.insertedId });
            } catch (error) {
                res.status(500).json({ message: 'Failed to create apartment', error: error.message });
            }
        });

        app.patch('/apartments/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const apartment = await apartmentCollection.findOne({ _id: new ObjectId(id) });

                if (!apartment) {
                    return res.status(404).json({ message: 'Apartment not found' });
                }

                const updatedApartment = buildApartmentData(req.body, apartment);

                await apartmentCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { ...updatedApartment, updatedAt: new Date() } }
                );

                res.json({ message: 'Apartment updated successfully' });
            } catch (error) {
                res.status(500).json({ message: 'Failed to update apartment', error: error.message });
            }
        });

        app.get('/apartments/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const apartment = await apartmentCollection.findOne({ _id: new ObjectId(id) });

                if (!apartment) {
                    return res.status(404).json({ message: 'Apartment not found' });
                }

                const relatedApartments = await apartmentCollection
                    .find({
                        _id: { $ne: new ObjectId(id) },
                        isPublic: true,
                        'meta.type': apartment?.meta?.type || 'apartment',
                    })
                    .sort({ 'meta.rating': -1, createdAt: -1 })
                    .limit(4)
                    .toArray();

                res.json({
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
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.status(400).json({ message: 'Invalid apartment id' });
                }

                res.status(500).json({ message: 'Failed to fetch apartment details', error: error.message });
            }
        });

        app.get('/apartments/:id/reviews', async (req, res) => {
            try {
                const { id } = req.params;
                const reviews = await reviewCollection.find({ apartmentId: id }).sort({ createdAt: -1 }).toArray();

                res.json(reviews);
            } catch (error) {
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.status(400).json({ message: 'Invalid apartment id' });
                }

                res.status(500).json({ message: 'Failed to fetch apartment reviews' });
            }
        });

        app.post('/apartments/:id/reviews', async (req, res) => {
            try {
                const { id } = req.params;
                const { userName, userEmail, comment, rating } = req.body;

                if (!comment || !String(comment).trim()) {
                    return res.status(400).json({ message: 'Comment is required' });
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

                res.status(201).json({ message: 'Review added successfully' });
            } catch (error) {
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.status(400).json({ message: 'Invalid apartment id' });
                }

                res.status(500).json({ message: 'Failed to add review' });
            }
        });

        app.post('/apartments/:id/actions', async (req, res) => {
            try {
                const { id } = req.params;
                const { action, userEmail } = req.body;

                if (!action) {
                    return res.status(400).json({ message: 'Action is required' });
                }

                const apartment = await apartmentCollection.findOne({ _id: new ObjectId(id) });
                if (!apartment) {
                    return res.status(404).json({ message: 'Apartment not found' });
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

                res.json({ message: 'Action recorded successfully' });
            } catch (error) {
                if (error?.message?.includes('input must be a 24 character hex string')) {
                    return res.status(400).json({ message: 'Invalid apartment id' });
                }

                res.status(500).json({ message: 'Failed to record action' });
            }
        });

        app.post(['/auth/register', '/register'], async (req, res) => {
            try {
                const { email, password, displayName } = req.body;

                if (!email || !password || !displayName) {
                    return res.status(400).json({ message: 'Email, password and display name are required.' });
                }

                const existingUser = await userCollection.findOne({ email });
                if (existingUser) {
                    return res.status(409).json({ message: 'User already exists.' });
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

                res.status(201).json({
                    message: 'User registered successfully',
                    userId: result.insertedId,
                });
            } catch (error) {
                res.status(500).json({ message: 'Failed to register user' });
            }
        });

        app.post(['/auth/login', '/login'], async (req, res) => {
            try {
                const { email, password } = req.body;

                if (!email || !password) {
                    return res.status(400).json({ message: 'Email and password are required.' });
                }

                const user = await userCollection.findOne({ email });
                if (!user || !user.password) {
                    return res.status(401).json({ message: 'Invalid credentials.' });
                }

                const isValidPassword = verifyPassword(password, user.password);
                if (!isValidPassword) {
                    return res.status(401).json({ message: 'Invalid credentials.' });
                }

                await userCollection.updateOne(
                    { email },
                    { $set: { lastLogin: new Date() } }
                );

                res.json({
                    message: 'Login successful',
                    user: {
                        email: user.email,
                        displayName: user.displayName,
                        role: user.role || 'user',
                    },
                });
            } catch (error) {
                res.status(500).json({ message: 'Failed to login user' });
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
                res.status(201).json({ message: 'Payment recorded successfully', paymentId: result.insertedId });
            } catch (error) {
                res.status(500).json({ message: 'Failed to record payment' });
            }
        });

        app.get('/payments/:email', async (req, res) => {
            const { email } = req.params;

            try {
                const payments = await paymentCollection.find({ userEmail: email }).toArray();
                res.json(payments);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch payment history' });
            }
        });

        // **Coupons**
        app.get('/coupons/:coupon', async (req, res) => {
            const { coupon } = req.params;

            try {
                const couponDetails = await couponCollection.findOne({ code: coupon });
                if (!couponDetails || new Date(couponDetails.expiration
                ) < new Date()) {
                    return res.status(404).json({ message: 'Invalid or expired coupon' });
                }
                res.json(couponDetails);
            } catch (error) {
                res.status(500).json({ message: 'Failed to validate coupon' });
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
                res.status(201).json({ message: 'Coupon created successfully', couponId: result.insertedId });
            } catch (error) {
                res.status(500).json({ message: 'Failed to create coupon' });
            }
        });
        app.get('/coupons', (req, res) => {
            couponCollection.find().toArray()
                .then(coupons => {
                    res.json(coupons); // Send all coupons as JSON
                })
                .catch(error => {
                    console.error('Error fetching coupons:', error);
                    res.status(500).json({ message: 'Failed to fetch coupons' });
                });
        })
        app.put('/coupons/:id', requireAuth, requireRole(['admin']), (req, res) => {
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
                        res.status(404).json({ message: 'Coupon not found' });
                    } else {
                        res.json({ message: 'Coupon updated successfully' });
                    }
                })
                .catch(error => res.status(500).json({ message: 'Failed to update coupon', error }));
        });
        app.delete('/coupons/:id', requireAuth, requireRole(['admin']), (req, res) => {
            const { id } = req.params;

            couponCollection.deleteOne({ _id: new ObjectId(id) })
                .then(result => {
                    if (result.deletedCount === 0) {
                        res.status(404).json({ message: 'Coupon not found' });
                    } else {
                        res.json({ message: 'Coupon deleted successfully' });
                    }
                })
                .catch(error => res.status(500).json({ message: 'Failed to delete coupon', error }));
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
        app.put('/users/:id', requireAuth, requireRole(['admin']), async (req, res) => {
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
                    res.status(201).json({
                        message: 'Announcement created successfully',
                        announcementId: result.insertedId,
                    });
                })
                .catch(error => {
                    console.error(error);
                    res.status(500).json({ message: 'Failed to create announcement' });
                });
        });
        app.get('/announcements', (req, res) => {
            announcementCollection.find().toArray()
                .then(announcements => {
                    res.json(announcements);
                })
                .catch(error => {
                    console.error(error);
                    res.status(500).json({ message: 'Failed to fetch announcements' });
                });
        });
        app.get('/reviews', async (req, res) => {
            try {
                const reviews = await reviewCollection.find().toArray();
                res.json(reviews);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch reviews', error });
            }
        });
        app.post('/create-payment-intent', async (req, res) => {
            const { price } = req.body;
            const amount = parseInt(price * 100);
            console.log('final amount',amount)

            const paymentIntent = await stripe.paymentIntents.create({
                amount: amount,
                currency: 'usd',
                payment_method_types: ['card']
            });
            res.send({
                clientSecret: paymentIntent.client_secret
            })
        });


        // Insert Payment record into DB
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
                res.status(201).json({ message: 'Payment recorded successfully', paymentId: result.insertedId });
            } catch (error) {
                console.error('Error recording payment:', error);
                res.status(500).json({ message: 'Failed to record payment' });
            }
        });


        // Accept or Reject Agreement - Combined
        app.put('/agreements/:id/update', requireAuth, requireRole(['admin', 'manager']), (req, res) => {
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
    res.send('EstateEase Backend is Running');
});

app.listen(port, () => {
    console.log(`Backend is running at: http://localhost:${port}`);
});