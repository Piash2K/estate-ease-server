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
        // Connect the client to the server (optional starting in v4.7)
        await client.connect();
        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

        const apartmentCollection = client.db('estateEase').collection('apartments');
        const agreementCollection = client.db('estateEase').collection('agreements');

        // Get apartment details
        app.get('/apartments', async (req, res) => {
            const cursor = apartmentCollection.find();
            const result = await cursor.toArray();
            res.send(result);
        });

        // Post request to create an agreement
        app.post('/agreements', async (req, res) => {
            const { userName, userEmail, floorNo, blockName, apartmentNo, rent } = req.body;

            // Check if the user already has an agreement for an apartment
            const existingAgreement = await agreementCollection.findOne({ userEmail });
            if (existingAgreement) {
                return res.status(400).json({ message: "User already has an agreement for an apartment." });
            }

            // Create the new agreement document
            const newAgreement = {
                userName,
                userEmail,
                floorNo,
                blockName,
                apartmentNo,
                rent,
                status: 'pending'
            };

            // Insert the new agreement into the database
            const result = await agreementCollection.insertOne(newAgreement);

            res.status(201).json({ message: 'Agreement created successfully', agreementId: result.insertedId });
        });

    } finally {
        // Ensures that the client will close when you finish/error
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Job is falling from the sky');
});

app.listen(port, () => {
    console.log(`Job is waiting at: ${port}`);
});