const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bcrypt = require("bcryptjs");
require("dotenv").config({ path: "./Backend/.env" });

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// MySQL connection
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

//TEMPROROYDEBUGGING: Log database connection details (excluding password)  
console.log("DB user:", process.env.DB_USER);
console.log("DB host:", process.env.DB_HOST);
console.log("DB name:", process.env.DB_NAME);
console.log("DB password loaded:", Boolean(process.env.DB_PASSWORD));
// Check MySQL connection
db.connect((err) => {
    if (err) {
        console.log("MySQL connection failed:", err.message);
        return;
    }

    console.log("MySQL connected successfully!");
});

// Home route
app.get("/", (req, res) => {
    res.send("Smart Hotel Backend is Running!");
});

// Get all rooms
app.get("/api/rooms", (req, res) => {
    const sql = "SELECT * FROM rooms";

    db.query(sql, (err, results) => {
        if (err) {
            console.log("Error fetching rooms:", err.message);

            return res.status(500).json({
                error: "Failed to fetch rooms"
            });
        }

        res.json(results);
    });
});



app.post("/api/bookings", (req, res) => {
    const {
        full_name,
        email,
        phone,
        check_in,
        check_out,
        adults,
        children,
        room_type,
        rooms_count,
        total_amount
    } = req.body;

    if (
        !full_name ||
        !email ||
        !check_in ||
        !check_out ||
        !room_type ||
        adults == null ||
        total_amount == null
    ) {
        return res.status(400).json({
            message: "Please provide all required booking details."
        });
    }

    const guestCount = Number(adults) + Number(children || 0);
    const amount = Number(total_amount);
    const roomCount = Number(rooms_count || 1);

    if (
        !Number.isInteger(guestCount) ||
        guestCount < 1 ||
        !Number.isInteger(roomCount) ||
        roomCount < 1 ||
        roomCount > 5 ||
        !Number.isFinite(amount) ||
        amount <= 0
    ) {
        return res.status(400).json({
            message: "Guest count, room count or total amount is invalid."
        });
    }

    if (check_out <= check_in) {
        return res.status(400).json({
            message: "Check-out must be after check-in."
        });
    }

    // Check that the selected room type exists.
    // Do not assign or mark any room as booked at this stage.
    const checkRoomTypeSql = `
        SELECT COUNT(*) AS total
        FROM rooms
        WHERE REPLACE(
                  REPLACE(LOWER(TRIM(room_type)), ' ', ''),
                  'room', ''
              ) = REPLACE(
                  REPLACE(LOWER(TRIM(?)), ' ', ''),
                  'room', ''
              )
    `;

    db.query(checkRoomTypeSql, [room_type], (err, results) => {
        if (err) {
            console.error("Room type check error:", err.message);
            return res.status(500).json({
                message: "Failed to validate room type."
            });
        }

        if (!results[0] || Number(results[0].total) === 0) {
            return res.status(400).json({
                message: "Selected room type does not exist."
            });
        }

        const bookingSql = `
            INSERT INTO bookings
            (
                room_id,
                customer_name,
                customer_email,
                customer_phone,
                check_in,
                check_out,
                guests,
                total_amount,
                status,
                room_type,
                rooms_count
            )
            VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
        `;

        db.query(
            bookingSql,
            [
                full_name.trim(),
                email.trim().toLowerCase(),
                phone || null,
                check_in,
                check_out,
                guestCount,
                amount,
                room_type.trim(),
                roomCount
            ],
            (bookingErr, bookingResult) => {
                if (bookingErr) {
                    console.error("Booking insert error:", bookingErr.message);
                    return res.status(500).json({
                        message: "Database could not save the booking."
                    });
                }

                return res.status(201).json({
                    message: "Booking created successfully. Room will be assigned at check-in after face verification.",
                    booking_id: bookingResult.insertId,
                    room_id: null,
                    room_number: null,
                    room_type: room_type.trim(),
                    rooms_count: roomCount,
                    status: "confirmed"
                });
            }
        );
    });
});


// Create payment record
app.post("/api/payments", (req, res) => {

    const {
        booking_id,
        payment_method,
        amount
    } = req.body;

    // Validate
    if (!booking_id || !payment_method || !amount) {
        return res.status(400).json({
            error: "Booking ID, payment method and amount are required"
        });
    }

    // Check booking exists
    const checkBookingSql =
        "SELECT id FROM bookings WHERE id = ?";

    db.query(
        checkBookingSql,
        [booking_id],
        (err, bookingResult) => {

            if (err) {
                console.log(
                    "Error checking booking:",
                    err.message
                );

                return res.status(500).json({
                    error: "Failed to verify booking"
                });
            }

            if (bookingResult.length === 0) {
                return res.status(404).json({
                    error: "Booking not found"
                });
            }

            // Generate demo transaction ID
            const transactionId =
                "TXN-" +
                Date.now();

            // Save payment
            const paymentSql = `
                INSERT INTO payments
                (
                    booking_id,
                    payment_method,
                    amount,
                    payment_status,
                    transaction_id
                )
                VALUES (?, ?, ?, 'paid', ?)
            `;

            db.query(
                paymentSql,
                [
                    booking_id,
                    payment_method,
                    amount,
                    transactionId
                ],
                (paymentErr, paymentResult) => {

                    if (paymentErr) {
                        console.log(
                            "Payment save error:",
                            paymentErr.message
                        );

                        return res.status(500).json({
                            error: "Failed to save payment"
                        });
                    }

                    res.status(201).json({
                        message:
                            "Payment saved successfully",

                        payment_id:
                            paymentResult.insertId,

                        booking_id:
                            booking_id,

                        transaction_id:
                            transactionId,

                        payment_status:
                            "paid"
                    });

                }
            );

        }
    );

});


app.post("/api/bookings/:id/cancel", (req, res) => {
    const bookingId = Number(req.params.id);

    if (!Number.isInteger(bookingId) || bookingId < 1) {
        return res.status(400).json({
            error: "Invalid booking ID."
        });
    }

    const findBookingSql = `
        SELECT id, status, room_id
        FROM bookings
        WHERE id = ?
    `;

    db.query(findBookingSql, [bookingId], (err, results) => {
        if (err) {
            console.error("Error finding booking:", err.message);
            return res.status(500).json({
                error: "Failed to find booking."
            });
        }

        if (results.length === 0) {
            return res.status(404).json({
                error: "Booking not found."
            });
        }

        const booking = results[0];
        const status = String(booking.status || "").toLowerCase();

        if (status === "cancelled") {
            return res.status(400).json({
                error: "Booking is already cancelled."
            });
        }

        if (
            status === "checked-in" ||
            status === "checked-out" ||
            status === "completed"
        ) {
            return res.status(400).json({
                error: "A checked-in or completed booking cannot be cancelled here."
            });
        }

        const findAssignedRoomsSql = `
            SELECT room_id
            FROM booking_rooms
            WHERE booking_id = ?
        `;

        db.query(
            findAssignedRoomsSql,
            [bookingId],
            (roomsErr, assignedRooms) => {
                if (roomsErr) {
                    console.error("Assigned rooms error:", roomsErr.message);
                    return res.status(500).json({
                        error: "Failed to find assigned rooms."
                    });
                }

                const roomIds = [
                    ...new Set([
                        ...(booking.room_id ? [Number(booking.room_id)] : []),
                        ...assignedRooms.map(row => Number(row.room_id))
                    ])
                ];

                db.query(
                    "UPDATE bookings SET status = 'cancelled' WHERE id = ?",
                    [bookingId],
                    (cancelErr) => {
                        if (cancelErr) {
                            console.error("Cancellation error:", cancelErr.message);
                            return res.status(500).json({
                                error: "Failed to cancel booking."
                            });
                        }

                        if (roomIds.length === 0) {
                            return res.json({
                                message: "Booking cancelled successfully. No room had been assigned.",
                                booking_id: bookingId,
                                released_rooms: []
                            });
                        }

                        db.query(
                            "UPDATE rooms SET status = 'available' WHERE id IN (?)",
                            [roomIds],
                            (roomErr) => {
                                if (roomErr) {
                                    console.error("Room release error:", roomErr.message);
                                    return res.status(500).json({
                                        error: "Booking was cancelled, but room status update failed."
                                    });
                                }

                                return res.json({
                                    message: "Booking cancelled successfully.",
                                    booking_id: bookingId,
                                    released_room_ids: roomIds
                                });
                            }
                        );
                    }
                );
            }
        );
    });
});

// ================= BOOKING HISTORY =================

app.get("/api/bookings/history/:userId", (req, res) => {

    const userId = req.params.userId;

    const sql = `
        SELECT
            b.id,
            b.user_id,
            b.status AS booking_status,
            b.check_in AS checkin,
            b.check_out AS checkout,
            b.guests,
            b.total_amount,
            r.room_number,
            r.room_type,
            p.payment_method
        FROM bookings b
        LEFT JOIN rooms r
            ON b.room_id = r.id
        LEFT JOIN payments p
            ON b.id = p.booking_id
        WHERE b.user_id = ?
          AND b.status IN ('cancelled', 'completed', 'checked-out')
        ORDER BY b.id DESC
    `;

    db.query(sql, [userId], (err, results) => {

        if (err) {
            console.log("History Error:", err.message);

            return res.status(500).json({
                error: "Failed to fetch booking history"
            });
        }

        res.json(results);
    });
});

// ================= REGISTER USER =================

app.post("/api/register", async (req, res) => {

    const {
        full_name,
        email,
        phone,
        username,
        password
    } = req.body;

    // Check required fields
    if (
        !full_name ||
        !email ||
        !phone ||
        !username ||
        !password
    ) {
        return res.status(400).json({
            error: "Please fill all required fields"
        });
    }

    try {

        // Check existing email or username
        const checkSql = `
            SELECT id
            FROM users
            WHERE email = ? OR username = ?
        `;

        db.query(
            checkSql,
            [email, username],
            async (err, results) => {

                if (err) {
                    console.log(
                        "User check error:",
                        err.message
                    );

                    return res.status(500).json({
                        error: "Database error"
                    });
                }

                if (results.length > 0) {

                    return res.status(409).json({
                        error:
                            "Email or username already exists"
                    });
                }

                // Hash password
                const passwordHash =
                    await bcrypt.hash(password, 10);

                // Insert user
                const insertSql = `
                    INSERT INTO users
                    (
                        full_name,
                        email,
                        phone,
                        username,
                        password_hash
                    )
                    VALUES (?, ?, ?, ?, ?)
                `;

                db.query(
                    insertSql,
                    [
                        full_name,
                        email,
                        phone,
                        username,
                        passwordHash
                    ],
                    (insertErr, result) => {

                        if (insertErr) {

                            console.log(
                                "User registration error:",
                                insertErr.message
                            );

                            return res.status(500).json({
                                error:
                                    "Failed to create account"
                            });
                        }

                        res.status(201).json({

                            message:
                                "Account created successfully",

                            user_id:
                                result.insertId

                        });

                    }
                );

            }
        );

    } catch (error) {

        console.log(
            "Registration error:",
            error.message
        );

        res.status(500).json({
            error: "Server error"
        });

    }

});

// ================= LOGIN USER =================

app.post("/api/login", (req, res) => {

    const {
        login,
        password
    } = req.body;

    // Check required fields
    if (!login || !password) {
        return res.status(400).json({
            error: "Email/Username and password are required"
        });
    }

    // Find user by email OR username
    const sql = `
        SELECT
            id,
            full_name,
            email,
            phone,
            username,
            password_hash
        FROM users
        WHERE email = ? OR username = ?
        LIMIT 1
    `;

    db.query(
        sql,
        [login, login],
        async (err, results) => {

            if (err) {
                console.log(
                    "Login database error:",
                    err.message
                );

                return res.status(500).json({
                    error: "Database error"
                });
            }

            // User not found
            if (results.length === 0) {
                return res.status(401).json({
                    error: "Invalid email/username or password"
                });
            }

            const user = results[0];

            try {

                // Compare entered password with hashed password
                const passwordMatch =
                    await bcrypt.compare(
                        password,
                        user.password_hash
                    );

                if (!passwordMatch) {

                    return res.status(401).json({
                        error:
                            "Invalid email/username or password"
                    });
                }

                // Never send password_hash to frontend
                res.json({
                    message: "Login successful",

                    user: {
                        id: user.id,
                        full_name: user.full_name,
                        email: user.email,
                        phone: user.phone,
                        username: user.username
                    }
                });

            } catch (error) {

                console.log(
                    "Password verification error:",
                    error.message
                );

                return res.status(500).json({
                    error: "Login failed"
                });
            }

        }
    );

});

/* ========== FACE RECOGNITION APIs ========== */

// Validate the face descriptor received from frontend
function isValidFaceDescriptor(descriptor) {
    return (
        Array.isArray(descriptor) &&
        descriptor.length === 128 &&
        descriptor.every(
            value =>
                typeof value === "number" &&
                Number.isFinite(value)
        )
    );
}

// Safely read a descriptor stored as MySQL JSON
function parseFaceDescriptor(value) {
    if (typeof value === "string") {
        return JSON.parse(value);
    }
    return value;
}

// 1. REGISTER FACE
app.post("/api/face/register", (req, res) => {
    const { email, descriptor } = req.body;

    if (
        typeof email !== "string" ||
        !email.trim() ||
        !isValidFaceDescriptor(descriptor)
    ) {
        return res.status(400).json({
            success: false,
            message: "Valid email and 128-number face descriptor are required."
        });
    }

    const guestEmail = email.trim().toLowerCase();

    const sql = `
        INSERT INTO guest_faces
        (guest_email, face_descriptor)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
        face_descriptor = VALUES(face_descriptor)
    `;

    db.query(
        sql,
        [guestEmail, JSON.stringify(descriptor)],
        (err, result) => {
            if (err) {
                console.error("Face registration error:", err);
                return res.status(500).json({
                    success: false,
                    message: "Could not save face descriptor."
                });
            }

            return res.status(200).json({
                success: true,
                message: "Face descriptor registered successfully."
            });
        }
    );
});


// 2. VERIFY FACE
app.post("/api/face/verify", (req, res) => {
    const { email, descriptor } = req.body;

    if (
        typeof email !== "string" ||
        !email.trim() ||
        !isValidFaceDescriptor(descriptor)
    ) {
        return res.status(400).json({
            success: false,
            matched: false,
            message: "Valid email and 128-number face descriptor are required."
        });
    }

    const guestEmail = email.trim().toLowerCase();

    db.query(
        "SELECT face_descriptor FROM guest_faces WHERE guest_email = ?",
        [guestEmail],
        (err, results) => {
            if (err) {
                console.error("Face verification error:", err);
                return res.status(500).json({
                    success: false,
                    matched: false,
                    message: "Face verification failed due to a server error."
                });
            }

            if (!results || results.length === 0) {
                return res.status(404).json({
                    success: false,
                    matched: false,
                    message: "No registered face found for this email."
                });
            }

            let savedDescriptor;

            try {
                savedDescriptor = parseFaceDescriptor(
                    results[0].face_descriptor
                );
            } catch (parseError) {
                console.error("Stored descriptor is invalid:", parseError);
                return res.status(500).json({
                    success: false,
                    matched: false,
                    message: "Stored face data is invalid."
                });
            }

            if (!isValidFaceDescriptor(savedDescriptor)) {
                return res.status(500).json({
                    success: false,
                    matched: false,
                    message: "Stored face descriptor has an invalid format."
                });
            }

            // Calculate Euclidean distance between both descriptors
            let sum = 0;

            for (let i = 0; i < 128; i++) {
                const difference =
                    descriptor[i] - savedDescriptor[i];

                sum += difference * difference;
            }

            const distance = Math.sqrt(sum);

            // Initial demo threshold; calibrate using real test samples
            const matched = distance < 0.50;

            return res.status(200).json({
                success: true,
                matched: matched,
                distance: Number(distance.toFixed(4)),
                message: matched
                    ? "Face matched successfully."
                    : "Face did not match the registered guest."
            });
        }
    );
});

app.post("/api/bookings/:id/check-in", (req, res) => {
    const bookingId = Number(req.params.id);
    const { descriptor } = req.body;

    if (!Number.isInteger(bookingId) || bookingId < 1) {
        return res.status(400).json({
            success: false,
            message: "Invalid booking ID."
        });
    }

    if (!isValidFaceDescriptor(descriptor)) {
        return res.status(400).json({
            success: false,
            matched: false,
            message: "A valid 128-number face descriptor is required."
        });
    }

    const bookingSql = `
        SELECT id, customer_email, room_type, rooms_count, room_id, status
        FROM bookings
        WHERE id = ?
    `;

    db.query(bookingSql, [bookingId], (err, bookings) => {
        if (err) {
            console.error("Check-in booking lookup error:", err.message);
            return res.status(500).json({
                success: false,
                message: "Could not retrieve booking."
            });
        }

        if (bookings.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking not found."
            });
        }

        const booking = bookings[0];

        if (String(booking.status).toLowerCase() !== "confirmed") {
            return res.status(409).json({
                success: false,
                message: "Only confirmed bookings can check in."
            });
        }

        if (booking.room_id !== null) {
            return res.status(409).json({
                success: false,
                message: "A room is already assigned to this booking."
            });
        }

        const guestEmail = String(booking.customer_email).trim().toLowerCase();

        db.query(
            "SELECT face_descriptor FROM guest_faces WHERE guest_email = ?",
            [guestEmail],
            (faceErr, faces) => {
                if (faceErr) {
                    console.error("Registered face lookup error:", faceErr.message);
                    return res.status(500).json({
                        success: false,
                        message: "Could not retrieve registered face."
                    });
                }

                if (!faces.length) {
                    return res.status(403).json({
                        success: false,
                        matched: false,
                        message: "No registered face found for this guest."
                    });
                }

                let savedDescriptor;

                try {
                    savedDescriptor = parseFaceDescriptor(faces[0].face_descriptor);
                } catch (parseErr) {
                    return res.status(500).json({
                        success: false,
                        message: "Stored face descriptor is invalid."
                    });
                }

                if (!isValidFaceDescriptor(savedDescriptor)) {
                    return res.status(500).json({
                        success: false,
                        message: "Stored face descriptor format is invalid."
                    });
                }

                let sum = 0;

                for (let i = 0; i < 128; i++) {
                    const difference = descriptor[i] - savedDescriptor[i];
                    sum += difference * difference;
                }

                const distance = Math.sqrt(sum);

                if (distance >= 0.50) {
                    return res.status(403).json({
                        success: false,
                        matched: false,
                        distance: Number(distance.toFixed(4)),
                        message: "Face did not match. No room assigned."
                    });
                }

                const roomCount = Number(booking.rooms_count || 1);

                if (
                    !Number.isInteger(roomCount) ||
                    roomCount < 1 ||
                    roomCount > 5 ||
                    !booking.room_type
                ) {
                    return res.status(400).json({
                        success: false,
                        message: "Booking room details are invalid."
                    });
                }

                db.beginTransaction((txErr) => {
                    if (txErr) {
                        console.error("Check-in transaction error:", txErr.message);
                        return res.status(500).json({
                            success: false,
                            message: "Could not start room assignment."
                        });
                    }

                    const findRoomsSql = `
                        SELECT id, room_number, room_type
                        FROM rooms
                        WHERE REPLACE(
                                  REPLACE(LOWER(TRIM(room_type)), ' ', ''),
                                  'room', ''
                              ) = REPLACE(
                                  REPLACE(LOWER(TRIM(?)), ' ', ''),
                                  'room', ''
                              )
                          AND LOWER(TRIM(status)) = 'available'
                        ORDER BY id
                        LIMIT ?
                        FOR UPDATE
                    `;

                    db.query(
                        findRoomsSql,
                        [booking.room_type, roomCount],
                        (roomErr, rooms) => {
                            if (roomErr || rooms.length !== roomCount) {
                                return db.rollback(() => {
                                    res.status(roomErr ? 500 : 409).json({
                                        success: false,
                                        message: roomErr
                                            ? "Could not find available rooms."
                                            : "Not enough available rooms of the selected type."
                                    });
                                });
                            }

                            const roomIds = rooms.map(room => room.id);

                            db.query(
                                "UPDATE rooms SET status = 'booked' WHERE id IN (?) AND LOWER(TRIM(status)) = 'available'",
                                [roomIds],
                                (updateErr, updateResult) => {
                                    if (updateErr || updateResult.affectedRows !== roomCount) {
                                        return db.rollback(() => {
                                            res.status(409).json({
                                                success: false,
                                                message: "Room availability changed. Please retry check-in."
                                            });
                                        });
                                    }

                                    const assignmentValues = rooms.map(room => [
                                        bookingId,
                                        room.id
                                    ]);

                                    db.query(
                                        "INSERT INTO booking_rooms (booking_id, room_id) VALUES ?",
                                        [assignmentValues],
                                        (assignErr) => {
                                            if (assignErr) {
                                                return db.rollback(() => {
                                                    console.error("Room assignment error:", assignErr.message);
                                                    res.status(500).json({
                                                        success: false,
                                                        message: "Could not save room assignments."
                                                    });
                                                });
                                            }

                                            db.query(
                                                "UPDATE bookings SET room_id = ?, status = 'checked-in' WHERE id = ? AND status = 'confirmed' AND room_id IS NULL",
                                                [rooms[0].id, bookingId],
                                                (bookingUpdateErr, bookingUpdateResult) => {
                                                    if (
                                                        bookingUpdateErr ||
                                                        bookingUpdateResult.affectedRows !== 1
                                                    ) {
                                                        return db.rollback(() => {
                                                            res.status(409).json({
                                                                success: false,
                                                                message: "Booking changed during check-in. Please retry."
                                                            });
                                                        });
                                                    }

                                                    db.commit((commitErr) => {
                                                        if (commitErr) {
                                                            return db.rollback(() => {
                                                                res.status(500).json({
                                                                    success: false,
                                                                    message: "Could not finish room assignment."
                                                                });
                                                            });
                                                        }

                                                        return res.json({
                                                            success: true,
                                                            matched: true,
                                                            booking_id: bookingId,
                                                            status: "checked-in",
                                                            distance: Number(distance.toFixed(4)),
                                                            assigned_rooms: rooms.map(room => ({
                                                                room_id: room.id,
                                                                room_number: room.room_number,
                                                                room_type: room.room_type
                                                            })),
                                                            message: "Face matched and room assignment completed."
                                                        });
                                                    });
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                });
            }
        );
    });
});


/* ========== END FACE RECOGNITION APIs ========== */

// Start server
const PORT = 5000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});