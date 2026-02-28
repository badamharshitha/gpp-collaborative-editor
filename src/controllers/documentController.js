const db = require('../db');

exports.createDocument = async (req, res) => {
    try {
        const { title, content } = req.body;
        const result = await db.query(
            'INSERT INTO documents (title, content, version) VALUES ($1, $2, 0) RETURNING *',
            [title, content || '']
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getDocuments = async (req, res) => {
    try {
        const result = await db.query('SELECT id, title FROM documents ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getDocumentById = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('SELECT * FROM documents WHERE id = $1', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.deleteDocument = async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db.query('DELETE FROM documents WHERE id = $1 RETURNING *', [id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
        res.status(204).send();
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
