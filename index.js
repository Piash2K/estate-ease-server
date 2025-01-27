const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 5000;

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
        await client.connect();
        console.log('Connected to MongoDB successfully!');

        // Collections
        const apartmentCollection = client.db('estateEase').collection('apartments');
        const agreementCollection = client.db('estateEase').collection('agreements');
        const paymentCollection = client.db('estateEase').collection('payments');
        const couponCollection = client.db('estateEase').collection('coupons');
        const userCollection = client.db('estateEase').collection('users');

        // Routes

        // **Apartments** - Get All Apartments
        app.get('/apartments', async (req, res) => {
            try {
                const apartments = await apartmentCollection.find().toArray();
                res.json(apartments);
            } catch (error) {
                res.status(500).json({ message: 'Failed to fetch apartments' });
            }
        });

        // **Agreements**
        app.post('/agreements', async (req, res) => {
            const { userName, userEmail, floorNo, blockName, apartmentNo, rent } = req.body;

            try {
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
                if (!couponDetails || new Date(couponDetails.expiry) < new Date()) {
                    return res.status(404).json({ message: 'Invalid or expired coupon' });
                }
                res.json(couponDetails);
            } catch (error) {
                res.status(500).json({ message: 'Failed to validate coupon' });
            }
        });
        app.post('/coupons', async (req, res) => {
            const { code, discount, expiry } = req.body;

            try {
                const newCoupon = { code, discount, expiry: new Date(expiry) };
                const result = await couponCollection.insertOne(newCoupon);
                res.status(201).json({ message: 'Coupon created successfully', couponId: result.insertedId });
            } catch (error) {
                res.status(500).json({ message: 'Failed to create coupon' });
            }
        });
        app.post('/users', async (req, res) => {
            const { email, displayName, lastLogin, role } = req.body;

            const existingUser = await userCollection.findOne({ email });

            if (existingUser) {
                const result = await userCollection.updateOne(
                    { email },
                    { $set: { lastLogin: new Date(lastLogin) } }
                );
                res.json({ message: 'User login time updated successfully', result });
            } else {
                const newUser = { email, displayName, role: role || 'user', lastLogin: new Date(lastLogin) };
                const result = await userCollection.insertOne(newUser);
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

        // Update User Role to "user"
        app.put('/users/:id', async (req, res) => {
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