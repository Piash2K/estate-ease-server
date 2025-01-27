const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.uouce.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect(); // Connect to MongoDB
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        // Collections
        const apartmentCollection = client.db('estateEase').collection('apartments');
        const agreementCollection = client.db('estateEase').collection('agreements');
        const paymentCollection = client.db('estateEase').collection('payments');
        const couponCollection = client.db('estateEase').collection('coupons');

        // Get apartment details
        app.get('/apartments', async (req, res) => {
            const cursor = apartmentCollection.find();
            const result = await cursor.toArray();
            res.send(result);
        });

        // Post request to create an agreement
        app.post('/agreements', async (req, res) => {
            const { userName, userEmail, floorNo, blockName, apartmentNo, rent } = req.body;

            const existingAgreement = await agreementCollection.findOne({ userEmail });
            if (existingAgreement) {
                return res.status(400).json({ message: "User already has an agreement for an apartment." });
            }

            const newAgreement = {
                userName,
                userEmail,
                floorNo,
                blockName,
                apartmentNo,
                rent,
                status: 'pending'
            };

            const result = await agreementCollection.insertOne(newAgreement);
            res.status(201).json({ message: 'Agreement created successfully', agreementId: result.insertedId });
        });

        // Get agreement details for a specific email
        app.get('/agreements/:email', async (req, res) => {
            const userEmail = req.params.email;
            const agreement = await agreementCollection.findOne({ userEmail });
            res.json(agreement || null);
        });

        // Create a new payment record
        app.post('/payments', async (req, res) => {
            const { userEmail, floorNo, blockName, apartmentNo, originalRent, finalRent, discount, month } = req.body;

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
            res.status(201).json({ message: 'Payment successful', paymentId: result.insertedId });
        });

        // Get payment history for a user
        app.get('/payments/:email', async (req, res) => {
            const userEmail = req.params.email;
            const payments = await paymentCollection.find({ userEmail }).toArray();
            res.send(payments);
        });

        // Create and validate coupons
        app.get('/coupons/:coupon', async (req, res) => {
            const couponCode = req.params.coupon;
            const coupon = await couponCollection.findOne({ code: couponCode });

            if (coupon && new Date(coupon.expiry) > new Date()) {
                res.json(coupon);
            } else {
                res.status(404).json({ message: 'Invalid or expired coupon' });
            }
        });

        app.post('/coupons', async (req, res) => {
            const { code, discount, expiry } = req.body;

            const newCoupon = {
                code,
                discount,
                expiry: new Date(expiry),
            };

            const result = await couponCollection.insertOne(newCoupon);
            res.status(201).json({ message: 'Coupon created successfully', couponId: result.insertedId });
        });
    } finally {
        // Do not close the client in production
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('To let for building');
});

app.listen(port, () => {
    console.log(`Building is waiting at: ${port}`);
});