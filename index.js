const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 5000;
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

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
        app.post('/coupons', async (req, res) => {
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
        app.put('/coupons/:id', (req, res) => {
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
        app.delete('/coupons/:id', (req, res) => {
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
        app.put('/agreements/:id/update', (req, res) => {
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