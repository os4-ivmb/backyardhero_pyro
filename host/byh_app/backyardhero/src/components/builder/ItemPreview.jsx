

export default function ItemPreview(props){
    return (
        <div>
            <div>
                Video
                
                {props.item.youtube_link ? (
                    <iframe src={`${props.item.youtube_link.replace("/watch?v=","/embed/").replace("?t=","?autoplay=1&amp;start=")}`} allow="autoplay"></iframe>
                ):""}
            </div>
        </div>
    )
}