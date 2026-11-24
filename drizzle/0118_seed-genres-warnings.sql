-- The starting genre and content warning lists. Moderators edit them in the
-- admin area afterwards; an entry already there is left alone.
INSERT INTO "tags" ("kind", "name", "slug") VALUES
	('genre', 'Fantasy', 'fantasy'),
	('genre', 'Science fiction', 'science-fiction'),
	('genre', 'Horror', 'horror'),
	('genre', 'Mystery', 'mystery'),
	('genre', 'Thriller', 'thriller'),
	('genre', 'Romance', 'romance'),
	('genre', 'Historical', 'historical'),
	('genre', 'Literary', 'literary'),
	('genre', 'Contemporary', 'contemporary'),
	('genre', 'Adventure', 'adventure'),
	('genre', 'Humour', 'humour'),
	('genre', 'Fan fiction', 'fan-fiction'),
	('genre', 'Poetry', 'poetry'),
	('genre', 'Campaign', 'campaign'),
	('warning', 'Graphic violence', 'graphic-violence'),
	('warning', 'Sexual content', 'sexual-content'),
	('warning', 'Death', 'death'),
	('warning', 'Self-harm', 'self-harm'),
	('warning', 'Abuse', 'abuse'),
	('warning', 'Substance use', 'substance-use'),
	('warning', 'Strong language', 'strong-language')
ON CONFLICT ("kind", "slug") DO NOTHING;
