import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
    const { id } = req.query;

    /*
        load_show: showId
        manual_fire: zone,target
        reboot_daemon: 
        stop_firing:
        unload_show
        set_brightness: brightness
        set_fire_repeat: repeat_ct
    */

    if (req.method === 'POST') {
        try{

            // Define the target folder and ensure it exists
            const folderPath = '/tmp/d_cmd';
            if (!fs.existsSync(folderPath)) {
                fs.mkdirSync(folderPath, { recursive: true });
            }

            // Create a file with the current millisecond timestamp
            const timestamp = Date.now();
            const filePath = path.join(folderPath, `${timestamp}.json`);

            // Serialize and write the JSON to the file
            fs.writeFileSync(filePath, JSON.stringify(req.body, null, 2));
        
            return res.status(200).json({ message: 'Commanded successfully.' });
        } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to command.' });
        }
    }

    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
}